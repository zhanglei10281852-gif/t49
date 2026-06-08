const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

function generateLetterNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const r = String(Math.floor(Math.random() * 9000) + 1000);
  return `XZ${y}${m}${d}${r}`;
}

router.post("/", async (req, res) => {
  const {
    case_id,
    sender_org_name,
    receiver_org_id,
    case_summary,
    collaboration_items,
    contact_person,
    contact_phone,
  } = req.body;

  if (
    !case_id ||
    !sender_org_name ||
    !receiver_org_id ||
    !case_summary ||
    !collaboration_items ||
    !contact_person ||
    !contact_phone
  ) {
    return res.status(400).json({ error: "缺少必填字段" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[caseInfo]] = await conn.execute(
      "SELECT id, case_no FROM cases WHERE id = ?",
      [case_id],
    );
    if (!caseInfo) {
      await conn.rollback();
      return res.status(404).json({ error: "案件不存在" });
    }

    const [[org]] = await conn.execute(
      "SELECT id, name FROM organizations WHERE id = ?",
      [receiver_org_id],
    );
    if (!org) {
      await conn.rollback();
      return res.status(404).json({ error: "接收机构不存在" });
    }

    const letter_no = generateLetterNo();

    const [result] = await conn.execute(
      `INSERT INTO collaboration_letters 
       (letter_no, case_id, sender_org_name, receiver_org_id, receiver_org_name, 
        case_summary, collaboration_items, contact_person, contact_phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '已发出')`,
      [
        letter_no,
        case_id,
        sender_org_name,
        receiver_org_id,
        org.name,
        case_summary,
        collaboration_items,
        contact_person,
        contact_phone,
      ],
    );

    await conn.commit();
    res
      .status(201)
      .json({ id: result.insertId, letter_no, message: "协作函已发出" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.get("/", async (req, res) => {
  const {
    status,
    case_id,
    receiver_org_id,
    sender_org_name,
    page = 1,
    size = 20,
  } = req.query;
  let conditions = [];
  let params = [];
  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (case_id) {
    conditions.push("case_id = ?");
    params.push(case_id);
  }
  if (receiver_org_id) {
    conditions.push("receiver_org_id = ?");
    params.push(receiver_org_id);
  }
  if (sender_org_name) {
    conditions.push("sender_org_name LIKE ?");
    params.push(`%${sender_org_name}%`);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM collaboration_letters${where}`,
    params,
  );
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const [data] = await pool.query(
    `SELECT cl.*, c.case_no 
     FROM collaboration_letters cl LEFT JOIN cases c ON cl.case_id = c.id
     ${where} 
     ORDER BY cl.created_at DESC 
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    `SELECT cl.*, c.case_no 
     FROM collaboration_letters cl LEFT JOIN cases c ON cl.case_id = c.id
     WHERE cl.id = ?`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "协作函不存在" });

  const [progress] = await pool.execute(
    "SELECT * FROM collaboration_progress WHERE letter_id = ? ORDER BY progress_date DESC, created_at DESC",
    [req.params.id],
  );

  res.json({ ...row, progress_list: progress });
});

router.put("/:id/receive", async (req, res) => {
  const [[letter]] = await pool.execute(
    "SELECT id, status FROM collaboration_letters WHERE id = ?",
    [req.params.id],
  );
  if (!letter) return res.status(404).json({ error: "协作函不存在" });
  if (letter.status !== "已发出") {
    return res.status(400).json({ error: "只有已发出状态的协作函可以接收" });
  }
  await pool.execute(
    "UPDATE collaboration_letters SET status = '已接收', received_at = NOW() WHERE id = ?",
    [req.params.id],
  );
  res.json({ message: "协作函已接收" });
});

router.put("/:id/start", async (req, res) => {
  const [[letter]] = await pool.execute(
    "SELECT id, status FROM collaboration_letters WHERE id = ?",
    [req.params.id],
  );
  if (!letter) return res.status(404).json({ error: "协作函不存在" });
  if (letter.status !== "已接收") {
    return res
      .status(400)
      .json({ error: "只有已接收状态的协作函可以开始协作" });
  }
  await pool.execute(
    "UPDATE collaboration_letters SET status = '协作中' WHERE id = ?",
    [req.params.id],
  );
  res.json({ message: "协作已开始" });
});

router.put("/:id/complete", async (req, res) => {
  const { result } = req.body;
  if (!result) return res.status(400).json({ error: "协作结果为必填" });
  const [[letter]] = await pool.execute(
    "SELECT id, status FROM collaboration_letters WHERE id = ?",
    [req.params.id],
  );
  if (!letter) return res.status(404).json({ error: "协作函不存在" });
  if (letter.status !== "协作中") {
    return res.status(400).json({ error: "只有协作中状态的协作函可以完成" });
  }
  await pool.execute(
    "UPDATE collaboration_letters SET status = '已完成', result = ?, completed_at = NOW() WHERE id = ?",
    [result, req.params.id],
  );
  res.json({ message: "协作已完成" });
});

router.put("/:id/reject", async (req, res) => {
  const { reject_reason } = req.body;
  if (!reject_reason)
    return res.status(400).json({ error: "拒绝原因必须填写" });
  const [[letter]] = await pool.execute(
    "SELECT id, status FROM collaboration_letters WHERE id = ?",
    [req.params.id],
  );
  if (!letter) return res.status(404).json({ error: "协作函不存在" });
  if (letter.status !== "已发出" && letter.status !== "已接收") {
    return res.status(400).json({ error: "当前状态不允许拒绝" });
  }
  await pool.execute(
    "UPDATE collaboration_letters SET status = '已拒绝', reject_reason = ? WHERE id = ?",
    [reject_reason, req.params.id],
  );
  res.json({ message: "协作已拒绝" });
});

router.post("/:id/progress", async (req, res) => {
  const { progress_date, content } = req.body;
  if (!progress_date || !content) {
    return res.status(400).json({ error: "进展日期和内容为必填" });
  }
  const [[letter]] = await pool.execute(
    "SELECT id, status FROM collaboration_letters WHERE id = ?",
    [req.params.id],
  );
  if (!letter) return res.status(404).json({ error: "协作函不存在" });
  if (letter.status !== "协作中") {
    return res.status(400).json({ error: "只有协作中状态可以录入进展" });
  }
  const [result] = await pool.execute(
    "INSERT INTO collaboration_progress (letter_id, progress_date, content) VALUES (?, ?, ?)",
    [req.params.id, progress_date, content],
  );
  res.status(201).json({ id: result.insertId, message: "进展录入成功" });
});

router.get("/:id/progress", async (req, res) => {
  const [data] = await pool.execute(
    "SELECT * FROM collaboration_progress WHERE letter_id = ? ORDER BY progress_date DESC, created_at DESC",
    [req.params.id],
  );
  res.json({ data });
});

module.exports = router;
