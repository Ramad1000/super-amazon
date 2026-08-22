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

router.get("/users", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status,
       is_verified, created_at FROM users ORDER BY created_at DESC`
    );
    return res.json({ success: true, users: result.rows });
  } catch (error) { return next(error); }
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
