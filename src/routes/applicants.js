const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.post("/", async (req, res) => {
  const { name, id_card, gender, phone, address, category, income_level } =
    req.body;
  if (!name || !id_card || !gender || !category) {
    return res.status(400).json({ error: "姓名、身份证号、性别、类别为必填" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO applicants (name, id_card, gender, phone, address, category, income_level) VALUES (?,?,?,?,?,?,?)",
      [
        name,
        id_card,
        gender,
        phone || null,
        address || null,
        category,
        income_level || null,
      ],
    );
    res.status(201).json({ id: result.insertId, message: "申请人录入成功" });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res.status(409).json({ error: "身份证号已存在" });
    res.status(500).json({ error: e.message });
  }
});

router.get("/", async (req, res) => {
  const { category, name, page = 1, size = 20 } = req.query;
  let conditions = [];
  let params = [];
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (name) {
    conditions.push("name LIKE ?");
    params.push(`%${name}%`);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM applicants${where}`,
    params,
  );
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const [data] = await pool.query(
    `SELECT * FROM applicants${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute("SELECT * FROM applicants WHERE id = ?", [
    req.params.id,
  ]);
  if (!row) return res.status(404).json({ error: "申请人不存在" });
  res.json(row);
});

router.put("/:id", async (req, res) => {
  const [[existing]] = await pool.execute(
    "SELECT id FROM applicants WHERE id = ?",
    [req.params.id],
  );
  if (!existing) return res.status(404).json({ error: "申请人不存在" });
  const fields = ["phone", "address", "category", "income_level"];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: "无更新字段" });
  params.push(req.params.id);
  await pool.execute(
    `UPDATE applicants SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  res.json({ message: "更新成功" });
});

module.exports = router;
