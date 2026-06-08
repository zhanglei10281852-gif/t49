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

  const [[{ co_cases }]] = await pool.execute(`
    SELECT COUNT(DISTINCT case_id) as co_cases 
    FROM case_lawyers 
    WHERE role = '协办'
  `);

  const coCaseRate = total > 0 ? ((co_cases / total) * 100).toFixed(2) : 0;

  res.json({
    total,
    pending,
    processing,
    closed,
    byType,
    co_cases,
    co_case_rate: coCaseRate + "%",
  });
});

router.get("/stats/co-lawyer-hours", async (req, res) => {
  const [data] = await pool.execute(`
    SELECT 
      l.id as lawyer_id,
      l.name as lawyer_name,
      COALESCE(SUM(cr.work_hours), 0) as total_hours,
      COUNT(DISTINCT cr.case_id) as case_count,
      COALESCE(SUM(s.amount), 0) as total_subsidy
    FROM lawyers l
    LEFT JOIN case_lawyers cl ON l.id = cl.lawyer_id AND cl.role = '协办'
    LEFT JOIN co_lawyer_records cr ON l.id = cr.lawyer_id
    LEFT JOIN subsidies s ON l.id = s.lawyer_id AND s.role = '协办'
    GROUP BY l.id, l.name
    ORDER BY total_hours DESC
  `);
  res.json({ data });
});

router.get("/stats/collaboration", async (req, res) => {
  const [[{ sent_count }]] = await pool.execute(
    "SELECT COUNT(*) as sent_count FROM collaboration_letters",
  );

  const [[{ received_count }]] = await pool.execute(
    "SELECT COUNT(*) as received_count FROM collaboration_letters WHERE status IN ('已接收', '协作中', '已完成')",
  );

  const [[{ completed_count }]] = await pool.execute(
    "SELECT COUNT(*) as completed_count FROM collaboration_letters WHERE status = '已完成'",
  );

  const [[{ rejected_count }]] = await pool.execute(
    "SELECT COUNT(*) as rejected_count FROM collaboration_letters WHERE status = '已拒绝'",
  );

  const rejectRate =
    sent_count > 0 ? ((rejected_count / sent_count) * 100).toFixed(2) : 0;

  const [[avgDurationData]] = await pool.execute(`
    SELECT AVG(TIMESTAMPDIFF(DAY, sent_at, completed_at)) as avg_days
    FROM collaboration_letters
    WHERE status = '已完成' AND completed_at IS NOT NULL
  `);
  const avg_duration_days = avgDurationData.avg_days
    ? parseFloat(avgDurationData.avg_days).toFixed(1)
    : 0;

  const [byOrg] = await pool.execute(`
    SELECT 
      receiver_org_id,
      receiver_org_name,
      COUNT(*) as collaboration_count,
      SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END) as completed_count
    FROM collaboration_letters
    GROUP BY receiver_org_id, receiver_org_name
    ORDER BY collaboration_count DESC
  `);

  res.json({
    sent_count,
    received_count,
    completed_count,
    rejected_count,
    reject_rate: rejectRate + "%",
    avg_duration_days,
    by_organization: byOrg,
  });
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

  const [lawyerList] = await pool.execute(
    `
    SELECT cl.id, cl.case_id, cl.lawyer_id, cl.role, cl.assigned_at,
           l.name, l.phone, l.firm, l.speciality
    FROM case_lawyers cl JOIN lawyers l ON cl.lawyer_id = l.id
    WHERE cl.case_id = ?
    ORDER BY CASE cl.role WHEN '主办' THEN 1 ELSE 2 END, cl.assigned_at ASC
  `,
    [req.params.id],
  );

  const [coRecords] = await pool.execute(
    `
    SELECT cr.*, l.name as lawyer_name
    FROM co_lawyer_records cr JOIN lawyers l ON cr.lawyer_id = l.id
    WHERE cr.case_id = ?
    ORDER BY cr.record_date DESC
  `,
    [req.params.id],
  );

  const [subsidies] = await pool.execute(
    `
    SELECT s.*, l.name as lawyer_name
    FROM subsidies s JOIN lawyers l ON s.lawyer_id = l.id
    WHERE s.case_id = ?
  `,
    [req.params.id],
  );

  res.json({
    ...row,
    lawyer_list: lawyerList,
    co_lawyer_records: coRecords,
    subsidies: subsidies,
  });
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
  const { lead_lawyer_id, co_lawyer_ids } = req.body;
  if (!lead_lawyer_id)
    return res.status(400).json({ error: "主办律师ID为必填" });

  const coIds = Array.isArray(co_lawyer_ids) ? co_lawyer_ids : [];
  if (coIds.length > 3)
    return res.status(400).json({ error: "协办律师最多3个" });

  const allIds = [lead_lawyer_id, ...coIds];
  const uniqueIds = [...new Set(allIds.map(Number))];
  if (uniqueIds.length !== allIds.length)
    return res.status(400).json({ error: "律师不能重复指派" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[c]] = await conn.execute("SELECT status FROM cases WHERE id = ?", [
      req.params.id,
    ]);
    if (!c) {
      await conn.rollback();
      return res.status(404).json({ error: "案件不存在" });
    }
    if (c.status !== "已批准") {
      await conn.rollback();
      return res.status(400).json({ error: "只有已批准状态可以指派律师" });
    }

    const [lawyers] = await conn.query(
      "SELECT id, status FROM lawyers WHERE id IN (?)",
      [allIds],
    );
    if (lawyers.length !== allIds.length) {
      await conn.rollback();
      return res.status(404).json({ error: "存在不存在的律师" });
    }
    const unavailable = lawyers.filter((l) => l.status !== "可接案");
    if (unavailable.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: "存在当前不可接案的律师" });
    }

    await conn.execute(
      "UPDATE cases SET lawyer_id = ?, status = ? WHERE id = ?",
      [lead_lawyer_id, "已指派", req.params.id],
    );

    await conn.execute(
      "INSERT INTO case_lawyers (case_id, lawyer_id, role) VALUES (?, ?, '主办')",
      [req.params.id, lead_lawyer_id],
    );

    for (const coId of coIds) {
      await conn.execute(
        "INSERT INTO case_lawyers (case_id, lawyer_id, role) VALUES (?, ?, '协办')",
        [req.params.id, coId],
      );
    }

    await conn.execute(
      "UPDATE lawyers SET status = ?, case_count = case_count + 1 WHERE id = ?",
      ["案件中", lead_lawyer_id],
    );

    await conn.commit();
    res.json({ message: "律师指派成功" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
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
  const { result, lead_subsidy } = req.body;
  if (!result) return res.status(400).json({ error: "结案结果为必填" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[c]] = await conn.execute(
      "SELECT status, lawyer_id FROM cases WHERE id = ?",
      [req.params.id],
    );
    if (!c) {
      await conn.rollback();
      return res.status(404).json({ error: "案件不存在" });
    }
    if (c.status !== "办理中") {
      await conn.rollback();
      return res.status(400).json({ error: "只有办理中状态可以结案" });
    }

    const leadSubsidy = parseFloat(lead_subsidy) || 0;

    await conn.execute(
      "UPDATE cases SET status = ?, result = ?, subsidy_amount = ? WHERE id = ?",
      ["已结案", result, leadSubsidy, req.params.id],
    );

    if (c.lawyer_id) {
      await conn.execute("UPDATE lawyers SET status = '可接案' WHERE id = ?", [
        c.lawyer_id,
      ]);

      await conn.execute(
        "INSERT INTO subsidies (case_id, lawyer_id, role, amount, work_hours) VALUES (?, ?, '主办', ?, 0)",
        [req.params.id, c.lawyer_id, leadSubsidy],
      );
    }

    const [coLawyers] = await conn.execute(
      "SELECT lawyer_id FROM case_lawyers WHERE case_id = ? AND role = '协办'",
      [req.params.id],
    );

    for (const co of coLawyers) {
      const [[hoursSummary]] = await conn.execute(
        "SELECT COALESCE(SUM(work_hours), 0) as total_hours FROM co_lawyer_records WHERE case_id = ? AND lawyer_id = ?",
        [req.params.id, co.lawyer_id],
      );
      const totalHours = parseFloat(hoursSummary.total_hours) || 0;
      let coSubsidy = totalHours * 100;
      if (coSubsidy > 500) coSubsidy = 500;

      await conn.execute(
        "INSERT INTO subsidies (case_id, lawyer_id, role, amount, work_hours) VALUES (?, ?, '协办', ?, ?)",
        [req.params.id, co.lawyer_id, coSubsidy, totalHours],
      );
    }

    await conn.commit();
    res.json({ message: "案件已结案" });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

router.post("/:id/co-records", async (req, res) => {
  const { lawyer_id, work_content, work_hours, record_date } = req.body;
  if (!lawyer_id || !work_content || !work_hours || !record_date) {
    return res
      .status(400)
      .json({ error: "律师ID、工作内容、工时、记录日期为必填" });
  }
  const hours = parseFloat(work_hours);
  if (isNaN(hours) || hours <= 0) {
    return res.status(400).json({ error: "工时必须为正数" });
  }

  const [[c]] = await pool.execute("SELECT status FROM cases WHERE id = ?", [
    req.params.id,
  ]);
  if (!c) return res.status(404).json({ error: "案件不存在" });
  if (c.status !== "办理中" && c.status !== "已指派") {
    return res.status(400).json({ error: "只有办理中的案件可以上报协办记录" });
  }

  const [[cl]] = await pool.execute(
    "SELECT id, role FROM case_lawyers WHERE case_id = ? AND lawyer_id = ?",
    [req.params.id, lawyer_id],
  );
  if (!cl || cl.role !== "协办") {
    return res.status(400).json({ error: "该律师不是本案协办律师" });
  }

  const [result] = await pool.execute(
    "INSERT INTO co_lawyer_records (case_id, lawyer_id, work_content, work_hours, record_date) VALUES (?, ?, ?, ?, ?)",
    [req.params.id, lawyer_id, work_content, hours, record_date],
  );

  res
    .status(201)
    .json({ id: result.insertId, message: "协办工作记录上报成功" });
});

router.get("/:id/co-records", async (req, res) => {
  const { lawyer_id } = req.query;
  let conditions = ["case_id = ?"];
  let params = [req.params.id];
  if (lawyer_id) {
    conditions.push("lawyer_id = ?");
    params.push(lawyer_id);
  }
  const where = " WHERE " + conditions.join(" AND ");
  const [data] = await pool.query(
    `
    SELECT cr.*, l.name as lawyer_name
    FROM co_lawyer_records cr JOIN lawyers l ON cr.lawyer_id = l.id
    ${where}
    ORDER BY cr.record_date DESC, cr.created_at DESC
  `,
    params,
  );
  res.json({ data });
});

module.exports = router;
