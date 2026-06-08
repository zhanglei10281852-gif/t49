const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.post("/", async (req, res) => {
  const {
    name,
    region,
    address,
    contact_person,
    contact_phone,
    cooperation_level,
  } = req.body;
  if (!name || !region) {
    return res.status(400).json({ error: "机构名称和所在区域为必填" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO organizations (name, region, address, contact_person, contact_phone, cooperation_level) VALUES (?, ?, ?, ?, ?, ?)",
      [
        name,
        region,
        address || null,
        contact_person || null,
        contact_phone || null,
        cooperation_level || "常规合作",
      ],
    );
    res
      .status(201)
      .json({ id: result.insertId, message: "机构添加成功" });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res.status(409).json({ error: "机构名称已存在" });
    res.status(500).json({ error: e.message });
  }
});

router.get("/", async (req, res) => {
  const { region, cooperation_level, name, page = 1, size = 20 } = req.query;
  let conditions = [];
  let params = [];
  if (region) {
    conditions.push("region = ?");
    params.push(region);
  }
  if (cooperation_level) {
    conditions.push("cooperation_level = ?");
    params.push(cooperation_level);
  }
  if (name) {
    conditions.push("name LIKE ?");
    params.push(`%${name}%`);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM organizations${where}`,
    params,
  );
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const [data] = await pool.query(
    `SELECT * FROM organizations${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    "SELECT * FROM organizations WHERE id = ?",
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "机构不存在" });
  res.json(row);
});

router.put("/:id", async (req, res) => {
  const [[existing]] = await pool.execute(
    "SELECT id FROM organizations WHERE id = ?",
    [req.params.id],
  );
  if (!existing) return res.status(404).json({ error: "机构不存在" });

  const fields = [
    "name",
    "region",
    "address",
    "contact_person",
    "contact_phone",
    "cooperation_level",
  ];
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
  try {
    await pool.execute(
      `UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
    res.json({ message: "更新成功" });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res.status(409).json({ error: "机构名称已存在" });
    res.status(500).json({ error: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  const [result] = await pool.execute(
    "DELETE FROM organizations WHERE id = ?",
    [req.params.id],
  );
  if (result.affectedRows === 0)
    return res.status(404).json({ error: "机构不存在" });
  res.json({ message: "删除成功" });
});

module.exports = router;
