const express = require("express");
const { pool, query } = require("../db/database");
const { auth, requireRoles } = require("../middleware/auth");

const router = express.Router();
router.use(auth, requireRoles("OWNER", "OWNER_ASSISTANT"));

router.get("/requests", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.*, u.telegram_id, u.telegram_username, u.telegram_name, u.account_type, u.status AS user_status
       FROM requests r JOIN users u ON u.id = r.user_id ORDER BY r.submitted_at DESC`
    );
    return res.json({ success: true, requests: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/dashboard", async (req, res, next) => {
  try {
    const [users, pendingRequests, openComplaints, finance] = await Promise.all([
      query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active FROM users`),
      query(`SELECT COUNT(*)::int AS total FROM requests WHERE status = 'PENDING'::request_status`),
      query(`SELECT COUNT(*)::int AS total FROM complaints WHERE status IN ('NEW','UNDER_REVIEW')`),
      query(`SELECT COALESCE(SUM(total_amount - paid_amount),0) AS remaining FROM broker_lifts`),
    ]);
    return res.json({ success: true, dashboard: {
      totalUsers: users.rows[0].total,
      activeUsers: users.rows[0].active,
      pendingRequests: pendingRequests.rows[0].total,
      openComplaints: openComplaints.rows[0].total,
      brokerRemaining: Number(finance.rows[0].remaining),
    }});
  } catch (error) { return next(error); }
});

router.get("/users", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status,
       is_verified, created_at FROM users ORDER BY created_at DESC`
    );
    return res.json({ success: true, users: result.rows });
  } catch (error) { return next(error); }
});

router.get("/finance/brokers", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.telegram_name, u.telegram_username,
       COALESCE(SUM(l.total_amount),0) AS total, COALESCE(SUM(l.paid_amount),0) AS paid
       FROM users u LEFT JOIN broker_lifts l ON l.broker_id = u.id
       WHERE u.account_type = 'BROKER'::account_type
       GROUP BY u.id ORDER BY u.telegram_name NULLS LAST`
    );
    return res.json({ success: true, brokers: result.rows });
  } catch (error) { return next(error); }
});

router.get("/finance/brokers/:id/lifts", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, total_amount, paid_amount, payment_method, created_at
       FROM broker_lifts WHERE broker_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return res.json({ success: true, lifts: result.rows });
  } catch (error) { return next(error); }
});

router.post("/finance/lifts", async (req, res, next) => {
  const brokerId = String(req.body?.brokerId || "");
  const amount = Number(req.body?.amount);
  const paymentMethod = String(req.body?.paymentMethod || "CASH");
  if (!brokerId || !Number.isFinite(amount) || amount <= 0 || !["CASH", "INSTALLMENTS"].includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: "بيانات الرفعة غير صالحة" });
  }
  try {
    const result = await query(
      `INSERT INTO broker_lifts (broker_id, total_amount, payment_method) VALUES ($1,$2,$3) RETURNING *`,
      [brokerId, amount, paymentMethod]
    );
    await query("INSERT INTO notifications (user_id,title,body) VALUES ($1,$2,$3)", [brokerId, "تمت إضافة رفعة مالية", `تمت إضافة رفعة بقيمة ${amount} د.ع إلى حسابك.`]);
    return res.status(201).json({ success: true, lift: result.rows[0] });
  } catch (error) { return next(error); }
});

router.post("/finance/payments", async (req, res, next) => {
  const brokerId = String(req.body?.brokerId || "");
  const liftId = req.body?.liftId || null;
  const amount = Number(req.body?.amount);
  const paymentType = String(req.body?.paymentType || "PAYMENT").slice(0, 30);
  if (!brokerId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "بيانات الدفعة غير صالحة" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (liftId) {
      const lift = await client.query("SELECT * FROM broker_lifts WHERE id = $1 AND broker_id = $2 FOR UPDATE", [liftId, brokerId]);
      if (!lift.rows.length) throw new Error("الرفعة غير موجودة");
      if (Number(lift.rows[0].paid_amount) + amount > Number(lift.rows[0].total_amount)) throw new Error("الدفعة أكبر من المبلغ المتبقي");
      await client.query("UPDATE broker_lifts SET paid_amount = paid_amount + $1 WHERE id = $2", [amount, liftId]);
    }
    const payment = await client.query(
      `INSERT INTO broker_payments (broker_id,lift_id,payment_type,amount,recorded_by,note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [brokerId, liftId, paymentType, amount, req.user.sub, String(req.body?.note || "").trim() || null]
    );
    await client.query("INSERT INTO notifications (user_id,title,body) VALUES ($1,$2,$3)", [brokerId, "تم تسجيل دفعة", `تم تسجيل دفعة بقيمة ${amount} د.ع.`]);
    await client.query("COMMIT");
    return res.status(201).json({ success: true, payment: payment.rows[0] });
  } catch (error) { await client.query("ROLLBACK"); return next(error); } finally { client.release(); }
});

router.patch("/users/:id/status", async (req, res, next) => {
  const status = String(req.body?.status || "").toUpperCase();
  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    return res.status(400).json({ success: false, message: "الحالة غير صالحة" });
  }
  if (req.params.id === req.user.sub) {
    return res.status(400).json({ success: false, message: "لا يمكنك إيقاف حسابك من هذه الصفحة" });
  }
  try {
    const result = await query(
      `UPDATE users SET status = $1::user_status, updated_at = NOW() WHERE id = $2
       RETURNING id, telegram_name, telegram_username, account_type, role, status, is_verified`,
      [status, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    const user = result.rows[0];
    await query("INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)", [
      user.id,
      status === "SUSPENDED" ? "تم إيقاف حسابك" : "تم تفعيل حسابك",
      status === "SUSPENDED" ? "تم إيقاف الحساب من الإدارة. تواصل مع الدعم عند الحاجة." : "تم تفعيل الحساب من الإدارة.",
    ]);
    return res.json({ success: true, user });
  } catch (error) { return next(error); }
});

router.patch("/requests/:id/review", async (req, res, next) => {
  const decision = req.body?.decision;
  const note = String(req.body?.note || "").trim();
  if (!["APPROVED", "NEEDS_CORRECTION", "REJECTED_FINAL"].includes(decision)) {
    return res.status(400).json({ success: false, message: "قرار المراجعة غير صالح" });
  }
  if (decision === "NEEDS_CORRECTION" && !note) {
    return res.status(400).json({ success: false, message: "اكتب ملاحظة توضح التصحيح المطلوب" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM requests WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!found.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "الطلب غير موجود" });
    }
    const request = found.rows[0];
    if (request.status !== "PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: "هذا الطلب ليس بانتظار المراجعة" });
    }
    const updated = await client.query(
      `UPDATE requests SET status = $1::request_status, reviewed_by = $2, review_note = $3,
       reviewed_at = NOW(), updated_at = NOW() WHERE id = $4 RETURNING *`,
      [decision, req.user.sub, note || null, request.id]
    );
    if (decision === "APPROVED") {
      await client.query(
        `UPDATE users SET account_type = $1::account_type, status = 'ACTIVE'::user_status,
         is_verified = true, updated_at = NOW() WHERE id = $2`,
        [request.applicant_type, request.user_id]
      );
    }
    const title = decision === "APPROVED" ? "تمت الموافقة على طلبك" : decision === "NEEDS_CORRECTION" ? "طلبك يحتاج إلى تعديل" : "تم رفض طلبك";
    const body = decision === "APPROVED"
      ? `تمت ترقية حسابك إلى ${request.applicant_type}.`
      : decision === "NEEDS_CORRECTION"
        ? `يرجى تصحيح الطلب ثم إعادة إرساله.${note ? ` ملاحظة: ${note}` : ""}`
        : (note || "تم رفض الطلب نهائيًا.");
    await client.query("INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)", [request.user_id, title, body]);
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'REVIEW_APPLICATION', 'REQUEST', $2, $3::jsonb)`,
      [req.user.sub, request.id, JSON.stringify({ decision, note })]
    );
    await client.query("COMMIT");
    return res.json({ success: true, request: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/complaints", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, a.telegram_name AS complainant_name, a.telegram_username AS complainant_username,
       t.telegram_name AS target_name, t.telegram_username AS target_username
       FROM complaints c
       JOIN users a ON a.id = c.complainant_id
       JOIN users t ON t.id = c.target_user_id
       ORDER BY c.created_at DESC`
    );
    return res.json({ success: true, complaints: result.rows });
  } catch (error) { return next(error); }
});

router.patch("/complaints/:id", async (req, res, next) => {
  const status = String(req.body?.status || "").toUpperCase();
  const note = String(req.body?.note || "").trim();
  if (!["UNDER_REVIEW", "RESOLVED", "REJECTED"].includes(status)) {
    return res.status(400).json({ success: false, message: "حالة الشكوى غير صالحة" });
  }
  try {
    const result = await query(
      `UPDATE complaints SET status = $1, owner_note = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, note || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    const complaint = result.rows[0];
    await query(
      "INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)",
      [complaint.complainant_id, "تم تحديث الشكوى", note || `تم تغيير حالة الشكوى إلى ${status}.`]
    );
    return res.json({ success: true, complaint });
  } catch (error) { return next(error); }
});

module.exports = router;
