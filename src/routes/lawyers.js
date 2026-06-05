const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.post("/", async (req, res) => {
  const { name, license_no, phone, firm, speciality } = req.body;
  if (!name || !license_no || !firm) {
    return res.status(400).json({ error: "姓名、执业证号、律所为必填" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO lawyers (name, license_no, phone, firm, speciality) VALUES (?,?,?,?,?)",
      [name, license_no, phone || null, firm, speciality || null],
    );
    res.status(201).json({ id: result.insertId, message: "律师录入成功" });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return res.status(409).json({ error: "执业证号已存在" });
    res.status(500).json({ error: e.message });
  }
});

router.get("/", async (req, res) => {
  const { status, page = 1, size = 20 } = req.query;
  let where = "";
  let params = [];
  if (status) {
    where = " WHERE status = ?";
    params.push(status);
  }
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM lawyers${where}`,
    params,
  );
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const [data] = await pool.query(
    `SELECT * FROM lawyers${where} ORDER BY case_count ASC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute("SELECT * FROM lawyers WHERE id = ?", [
    req.params.id,
  ]);
  if (!row) return res.status(404).json({ error: "律师不存在" });
  res.json(row);
});

router.put("/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!["可接案", "案件中", "休假"].includes(status)) {
    return res.status(400).json({ error: "无效状态" });
  }
  const [result] = await pool.execute(
    "UPDATE lawyers SET status = ? WHERE id = ?",
    [status, req.params.id],
  );
  if (result.affectedRows === 0)
    return res.status(404).json({ error: "律师不存在" });
  res.json({ message: "状态更新成功" });
});

module.exports = router;
