const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

function generateCaseNo() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const r = String(Math.floor(Math.random() * 9000) + 1000);
  return `FA${y}${m}${d}${r}`;
}

router.post("/", async (req, res) => {
  const { applicant_id, case_type, description } = req.body;
  if (!applicant_id || !case_type) {
    return res.status(400).json({ error: "申请人ID和案件类型为必填" });
  }
  const [[applicant]] = await pool.execute(
    "SELECT id FROM applicants WHERE id = ?",
    [applicant_id],
  );
  if (!applicant) return res.status(404).json({ error: "申请人不存在" });
  const case_no = generateCaseNo();
  const [result] = await pool.execute(
    "INSERT INTO cases (case_no, applicant_id, case_type, description) VALUES (?,?,?,?)",
    [case_no, applicant_id, case_type, description || null],
  );
  res
    .status(201)
    .json({ id: result.insertId, case_no, message: "案件创建成功" });
});

router.get("/stats/overview", async (req, res) => {
  const [[{ total }]] = await pool.execute(
    "SELECT COUNT(*) as total FROM cases",
  );
  const [[{ pending }]] = await pool.execute(
    "SELECT COUNT(*) as pending FROM cases WHERE status = '待审批'",
  );
  const [[{ processing }]] = await pool.execute(
    "SELECT COUNT(*) as processing FROM cases WHERE status = '办理中'",
  );
  const [[{ closed }]] = await pool.execute(
    "SELECT COUNT(*) as closed FROM cases WHERE status = '已结案'",
  );
  const [byType] = await pool.execute(
    "SELECT case_type, COUNT(*) as count FROM cases GROUP BY case_type",
  );
  res.json({ total, pending, processing, closed, byType });
});

router.get("/", async (req, res) => {
  const { status, case_type, applicant_id, page = 1, size = 20 } = req.query;
  let conditions = [];
  let params = [];
  if (status) {
    conditions.push("c.status = ?");
    params.push(status);
  }
  if (case_type) {
    conditions.push("c.case_type = ?");
    params.push(case_type);
  }
  if (applicant_id) {
    conditions.push("c.applicant_id = ?");
    params.push(applicant_id);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM cases c${where}`,
    params,
  );
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const [data] = await pool.query(
    `
    SELECT c.*, a.name as applicant_name, l.name as lawyer_name
    FROM cases c LEFT JOIN applicants a ON c.applicant_id = a.id LEFT JOIN lawyers l ON c.lawyer_id = l.id
    ${where} ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}
  `,
    params,
  );
  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    `
    SELECT c.*, a.name as applicant_name, a.category as applicant_category,
           l.name as lawyer_name, l.phone as lawyer_phone
    FROM cases c LEFT JOIN applicants a ON c.applicant_id = a.id LEFT JOIN lawyers l ON c.lawyer_id = l.id
    WHERE c.id = ?
  `,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "案件不存在" });
  res.json(row);
});

router.put("/:id/approve", async (req, res) => {
  const [[c]] = await pool.execute("SELECT status FROM cases WHERE id = ?", [
    req.params.id,
  ]);
  if (!c) return res.status(404).json({ error: "案件不存在" });
  if (c.status !== "待审批")
    return res.status(400).json({ error: "只有待审批状态可以审批" });
  const { action, reason } = req.body;
  if (action === "approve") {
    await pool.execute(
      "UPDATE cases SET status = ?, approve_reason = ? WHERE id = ?",
      ["已批准", reason || null, req.params.id],
    );
    res.json({ message: "审批通过" });
  } else if (action === "reject") {
    if (!reason) return res.status(400).json({ error: "驳回必须填写原因" });
    await pool.execute(
      "UPDATE cases SET status = ?, reject_reason = ? WHERE id = ?",
      ["已驳回", reason, req.params.id],
    );
    res.json({ message: "已驳回" });
  } else {
    res.status(400).json({ error: "无效操作" });
  }
});

router.put("/:id/assign", async (req, res) => {
  const { lawyer_id } = req.body;
  if (!lawyer_id) return res.status(400).json({ error: "律师ID为必填" });
  const [[c]] = await pool.execute("SELECT status FROM cases WHERE id = ?", [
    req.params.id,
  ]);
  if (!c) return res.status(404).json({ error: "案件不存在" });
  if (c.status !== "已批准")
    return res.status(400).json({ error: "只有已批准状态可以指派律师" });
  const [[lawyer]] = await pool.execute(
    "SELECT id, status FROM lawyers WHERE id = ?",
    [lawyer_id],
  );
  if (!lawyer) return res.status(404).json({ error: "律师不存在" });
  if (lawyer.status !== "可接案")
    return res.status(400).json({ error: "该律师当前不可接案" });
  await pool.execute(
    "UPDATE cases SET lawyer_id = ?, status = ? WHERE id = ?",
    [lawyer_id, "已指派", req.params.id],
  );
  await pool.execute(
    "UPDATE lawyers SET status = ?, case_count = case_count + 1 WHERE id = ?",
    ["案件中", lawyer_id],
  );
  res.json({ message: "律师指派成功" });
});

router.put("/:id/start", async (req, res) => {
  const [[c]] = await pool.execute("SELECT status FROM cases WHERE id = ?", [
    req.params.id,
  ]);
  if (!c) return res.status(404).json({ error: "案件不存在" });
  if (c.status !== "已指派")
    return res.status(400).json({ error: "只有已指派状态可以开始办理" });
  await pool.execute("UPDATE cases SET status = ? WHERE id = ?", [
    "办理中",
    req.params.id,
  ]);
  res.json({ message: "案件开始办理" });
});

router.put("/:id/close", async (req, res) => {
  const { result } = req.body;
  if (!result) return res.status(400).json({ error: "结案结果为必填" });
  const [[c]] = await pool.execute(
    "SELECT status, lawyer_id FROM cases WHERE id = ?",
    [req.params.id],
  );
  if (!c) return res.status(404).json({ error: "案件不存在" });
  if (c.status !== "办理中")
    return res.status(400).json({ error: "只有办理中状态可以结案" });
  await pool.execute("UPDATE cases SET status = ?, result = ? WHERE id = ?", [
    "已结案",
    result,
    req.params.id,
  ]);
  if (c.lawyer_id) {
    await pool.execute("UPDATE lawyers SET status = '可接案' WHERE id = ?", [
      c.lawyer_id,
    ]);
  }
  res.json({ message: "案件已结案" });
});

module.exports = router;
