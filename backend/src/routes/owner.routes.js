const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pool, query } = require("../db/database");
const { auth, requireRoles } = require("../middleware/auth");
const { notifyUser } = require("../services/notification.service");
const { streamFromTelegram, configured: telegramStorageConfigured, inspectStorage } = require("../services/telegram-storage.service");

const router = express.Router();
router.use(auth, requireRoles("OWNER", "OWNER_ASSISTANT"));

// Owner assistants never inherit the full Owner panel. Each protected section
// checks the exact permission assigned from the Owner dashboard.
function requireOwnerPermission(permission) {
  return async (req, res, next) => {
    if (req.user.role === "OWNER") return next();
    try {
      const allowed = await query(
        "SELECT 1 FROM assistant_permissions WHERE assistant_id = $1 AND permission = $2",
        [req.user.sub, permission]
      );
      if (!allowed.rows.length) {
        return res.status(403).json({ success: false, message: "ليس لديك صلاحية الوصول إلى هذا القسم" });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

router.get("/requests", requireOwnerPermission("REQUESTS"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "").trim().toUpperCase();
    const filters = [];
    const values = [];
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(r.full_name ILIKE $${values.length} OR r.father_phone ILIKE $${values.length} OR r.national_id ILIKE $${values.length} OR CAST(r.request_number AS text) ILIKE $${values.length} OR u.telegram_id ILIKE $${values.length} OR u.telegram_username ILIKE $${values.length} OR u.telegram_name ILIKE $${values.length})`);
    }
    if (["PENDING", "NEEDS_CORRECTION", "APPROVED", "REJECTED_FINAL"].includes(status)) {
      values.push(status);
      filters.push(`r.status = $${values.length}::request_status`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const count = await query(`SELECT COUNT(*)::int AS total FROM requests r JOIN users u ON u.id = r.user_id ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const result = await query(
      `SELECT r.*, u.telegram_id, u.telegram_username, u.telegram_name, u.account_type, u.status AS user_status
       FROM requests r JOIN users u ON u.id = r.user_id ${where}
       ORDER BY r.submitted_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return res.json({ success: true, requests: result.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.max(1, Math.ceil(count.rows[0].total / limit)) } });
  } catch (error) {
    return next(error);
  }
});

router.get("/requests/:id", requireOwnerPermission("REQUESTS"), async (req, res, next) => {
  try {
    const request = await query(
      `SELECT r.*, u.telegram_id, u.telegram_id, u.telegram_username, u.telegram_name, u.account_type, u.status AS user_status
       FROM requests r JOIN users u ON u.id = r.user_id WHERE r.id = $1`,
      [req.params.id]
    );
    if (!request.rows.length) return res.status(404).json({ success: false, message: "الطلب غير موجود" });
    const files = await query(
      `SELECT id, file_type, original_name, mime_type, file_size, sha256_hash, created_at
       FROM request_files WHERE request_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    return res.json({ success: true, request: { ...request.rows[0], files: files.rows } });
  } catch (error) { return next(error); }
});

router.get("/requests/:requestId/files/:fileId", requireOwnerPermission("REQUESTS"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.original_name, f.mime_type, f.storage_path, f.telegram_file_id FROM request_files f
       JOIN requests r ON r.id = f.request_id WHERE f.id = $1 AND r.id = $2`,
      [req.params.fileId, req.params.requestId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "المرفق غير موجود" });
    const file = result.rows[0];
    if (file.telegram_file_id) return streamFromTelegram(file.telegram_file_id, file.mime_type, res);
    const absolutePath = path.resolve(file.storage_path);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ success: false, message: "هذا المرفق قديم وفُقد من مساحة Render المؤقتة. اطلب من المتقدم إعادة رفعه." });
    res.type(file.mime_type);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    return res.sendFile(absolutePath);
  } catch (error) { return next(error); }
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

router.get("/reports", requireOwnerPermission("REPORTS"), async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const [users, requests, complaints, finance] = await Promise.all([
      query(`SELECT account_type, COUNT(*)::int AS total FROM users GROUP BY account_type`),
      query(`SELECT status, COUNT(*)::int AS total FROM requests WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY status`, [days]),
      query(`SELECT status, COUNT(*)::int AS total FROM complaints WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day') GROUP BY status`, [days]),
      query(`SELECT COALESCE(SUM(total_amount),0) AS total, COALESCE(SUM(paid_amount),0) AS paid FROM broker_lifts WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')`, [days]),
    ]);
    return res.json({ success: true, report: {
      users: users.rows, requests: requests.rows, complaints: complaints.rows,
      finance: { total: Number(finance.rows[0].total), paid: Number(finance.rows[0].paid) },
      periodDays: days,
      generatedAt: new Date().toISOString(),
    }});
  } catch (error) { return next(error); }
});

router.get("/assistants", requireRoles("OWNER"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.telegram_name, u.telegram_username, u.account_type, u.status, u.created_at,
       COALESCE(array_agg(ap.permission) FILTER (WHERE ap.permission IS NOT NULL), '{}') AS permissions
       FROM users u LEFT JOIN assistant_permissions ap ON ap.assistant_id = u.id
       WHERE u.role = 'OWNER_ASSISTANT'::user_role
       GROUP BY u.id ORDER BY u.created_at DESC`
    );
    return res.json({ success: true, assistants: result.rows });
  } catch (error) { return next(error); }
});

router.post("/assistants", requireRoles("OWNER"), async (req, res, next) => {
  const userId = String(req.body?.userId || "");
  const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String).filter(Boolean).slice(0, 8) : [];
  if (!userId) return res.status(400).json({ success: false, message: "اختر المستخدم أولًا" });
  try {
    const user = await query(`UPDATE users SET role = 'OWNER_ASSISTANT'::user_role, updated_at = NOW() WHERE id = $1 AND role <> 'OWNER'::user_role RETURNING id, telegram_name`, [userId]);
    if (!user.rows.length) return res.status(400).json({ success: false, message: "لا يمكن تعيين هذا الحساب مساعدًا" });
    await query("DELETE FROM assistant_permissions WHERE assistant_id = $1", [userId]);
    for (const permission of permissions) await query("INSERT INTO assistant_permissions (assistant_id, permission) VALUES ($1,$2)", [userId, permission]);
    await query("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'ASSIGN_OWNER_ASSISTANT','USER',$2,$3::jsonb)", [req.user.sub, userId, JSON.stringify({ permissions })]);
    return res.status(201).json({ success: true, assistant: user.rows[0] });
  } catch (error) { return next(error); }
});

router.delete("/assistants/:id", requireRoles("OWNER"), async (req, res, next) => {
  try {
    const result = await query(`UPDATE users SET role = 'MEMBER'::user_role, updated_at = NOW() WHERE id = $1 AND role = 'OWNER_ASSISTANT'::user_role RETURNING id, telegram_name`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "المساعد غير موجود" });
    await query("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id) VALUES ($1,'REMOVE_OWNER_ASSISTANT','USER',$2)", [req.user.sub, req.params.id]);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

router.get("/audit", requireOwnerPermission("AUDIT"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 30));
    const action = String(req.query.action || "").trim();
    const search = String(req.query.search || "").trim();
    const where = [];
    const values = [];
    if (action) { values.push(action); where.push(`a.action = $${values.length}`); }
    if (search) { values.push(`%${search}%`); where.push(`(a.action ILIKE $${values.length} OR a.target_type ILIKE $${values.length} OR a.target_id ILIKE $${values.length} OR u.telegram_name ILIKE $${values.length} OR u.telegram_username ILIKE $${values.length})`); }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = await query(`SELECT COUNT(*)::int AS total FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${filter}`, values);
    values.push(limit, (page - 1) * limit);
    const result = await query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at,
       u.telegram_name, u.telegram_username FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_user_id ${filter}
       ORDER BY a.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return res.json({ success: true, logs: result.rows, pagination: { page, limit, total: total.rows[0].total, pages: Math.max(1, Math.ceil(total.rows[0].total / limit)) } });
  } catch (error) { return next(error); }
});

router.get("/system", requireOwnerPermission("SYSTEM"), async (req, res, next) => {
  try {
    const started = Date.now();
    await query("SELECT 1");
    return res.json({ success: true, system: {
      database: "OPERATIONAL", api: "OPERATIONAL", databaseLatencyMs: Date.now() - started,
      uptimeSeconds: Math.floor(process.uptime()), node: process.version, serverTime: new Date().toISOString(),
      telegramStorage: telegramStorageConfigured() ? "CONFIGURED" : "NOT_CONFIGURED",
    }});
  } catch (error) { return next(error); }
});

router.post("/system/test-storage", requireRoles("OWNER"), async (req, res, next) => {
  try {
    const storage = await inspectStorage();
    return res.json({ success: true, storage });
  } catch (error) { return next(error); }
});

router.get("/backups", requireOwnerPermission("BACKUP"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, started_at, finished_at, status, file_size, sha256_hash, telegram_message_id, error_message
       FROM backup_logs ORDER BY started_at DESC LIMIT 50`
    );
    return res.json({ success: true, backups: result.rows });
  } catch (error) { return next(error); }
});

router.get("/backup-settings", requireRoles("OWNER"), async (req, res, next) => {
  try {
    const result = await query("SELECT value FROM system_settings WHERE key = 'backup_telegram_channel'");
    const channelId = result.rows[0]?.value?.channelId || "";
    return res.json({ success: true, channelId });
  } catch (error) { return next(error); }
});

router.put("/backup-settings", requireRoles("OWNER"), async (req, res, next) => {
  const channelId = String(req.body?.channelId || "").trim();
  if (!/^(?:-100\d{6,}|@[A-Za-z0-9_]{5,})$/.test(channelId)) {
    return res.status(400).json({ success: false, message: "أدخل معرّف قناة صحيحًا: -100... للقناة الخاصة أو @username للقناة العامة" });
  }
  try {
    await query(
      `INSERT INTO system_settings (key, value, updated_by, updated_at)
       VALUES ('backup_telegram_channel', $1::jsonb, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify({ channelId }), req.user.sub]
    );
    return res.json({ success: true, channelId });
  } catch (error) { return next(error); }
});

router.post("/backups", requireRoles("OWNER"), async (req, res, next) => {
  const startedAt = new Date();
  let backupId = null;
  let filePath = null;

  try {
    const created = await query(
      "INSERT INTO backup_logs (started_at, status) VALUES ($1, 'RUNNING') RETURNING id",
      [startedAt]
    );
    backupId = created.rows[0].id;

    const settings = await query("SELECT value FROM system_settings WHERE key = 'backup_telegram_channel'");
    const backupChannelId = settings.rows[0]?.value?.channelId || "";
    if (!backupChannelId) {
      const error = new Error("لم يتم تحديد قناة النسخ الاحتياطي من لوحة Owner");
      error.statusCode = 400;
      throw error;
    }

    const [users, requests, requestFiles, complaints, complaintFiles, complaintMessages, brokerLifts, brokerPayments, announcements, notifications, assistantPermissions, auditLogs, settingRows] = await Promise.all([
      query("SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status, is_verified, created_at, updated_at FROM users ORDER BY created_at"),
      query("SELECT * FROM requests ORDER BY created_at"),
      query("SELECT * FROM request_files ORDER BY created_at"),
      query("SELECT * FROM complaints ORDER BY created_at"),
      query("SELECT * FROM complaint_files ORDER BY created_at"),
      query("SELECT * FROM complaint_messages ORDER BY created_at"),
      query("SELECT * FROM broker_lifts ORDER BY created_at"),
      query("SELECT * FROM broker_payments ORDER BY payment_date"),
      query("SELECT * FROM announcements ORDER BY created_at"),
      query("SELECT * FROM notifications ORDER BY created_at"),
      query("SELECT * FROM assistant_permissions ORDER BY assistant_id, permission"),
      query("SELECT * FROM audit_logs ORDER BY created_at"),
      query("SELECT * FROM system_settings ORDER BY key"),
    ]);

    const backup = Buffer.from(JSON.stringify({
      format: "super-amazon-backup-v1",
      generatedAt: new Date().toISOString(),
      data: {
        users: users.rows, requests: requests.rows, requestFiles: requestFiles.rows,
        complaints: complaints.rows, complaintFiles: complaintFiles.rows, complaintMessages: complaintMessages.rows,
        brokerLifts: brokerLifts.rows, brokerPayments: brokerPayments.rows,
        announcements: announcements.rows, notifications: notifications.rows, assistantPermissions: assistantPermissions.rows,
        auditLogs: auditLogs.rows, settings: settingRows.rows,
      },
    }));
    const compressed = zlib.gzipSync(backup, { level: 9 });
    const tempDirectory = path.resolve(__dirname, "../../tmp");
    fs.mkdirSync(tempDirectory, { recursive: true });
    const filename = `super-amazon-backup-${startedAt.toISOString().replace(/[:.]/g, "-")}.json.gz`;
    filePath = path.join(tempDirectory, filename);
    fs.writeFileSync(filePath, compressed);

    const sha256 = crypto.createHash("sha256").update(compressed).digest("hex");
    const telegramFile = await uploadToTelegram({
      path: filePath,
      originalname: filename,
      mimetype: "application/gzip",
      size: compressed.length,
    }, "Super Amazon • نسخة احتياطية مشفرة من بيانات المنصة", backupChannelId);

    const saved = await query(
      `UPDATE backup_logs SET finished_at = NOW(), status = 'SUCCESS', file_size = $1, sha256_hash = $2,
       telegram_message_id = $3 WHERE id = $4 RETURNING *`,
      [compressed.length, sha256, String(telegramFile.messageId || ""), backupId]
    );
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'CREATE_BACKUP', 'BACKUP', $2, $3::jsonb)`,
      [req.user.sub, backupId, JSON.stringify({ fileSize: compressed.length, sha256 })]
    );
    return res.status(201).json({ success: true, backup: saved.rows[0] });
  } catch (error) {
    if (backupId) {
      await query(
        "UPDATE backup_logs SET finished_at = NOW(), status = 'FAILED', error_message = $1 WHERE id = $2",
        [String(error.message || "فشل إنشاء النسخة").slice(0, 1000), backupId]
      ).catch(() => {});
    }
    return next(error);
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

router.get("/users", requireOwnerPermission("USERS"), async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || "").trim();
    const values = [];
    let where = "";
    if (search) {
      values.push(`%${search}%`);
      where = `WHERE (telegram_id ILIKE $1 OR telegram_username ILIKE $1 OR telegram_name ILIKE $1 OR CAST(account_type AS text) ILIKE $1 OR CAST(role AS text) ILIKE $1)`;
    }
    const count = await query(`SELECT COUNT(*)::int AS total FROM users ${where}`, values);
    values.push(limit, (page - 1) * limit);
    const result = await query(
      `SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status,
       is_verified, created_at FROM users ${where} ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return res.json({ success: true, users: result.rows, pagination: { page, limit, total: count.rows[0].total, pages: Math.max(1, Math.ceil(count.rows[0].total / limit)) } });
  } catch (error) { return next(error); }
});

router.get("/finance/brokers", requireOwnerPermission("FINANCE"), async (req, res, next) => {
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

// Former brokers remain in the database, but must not appear in the active
// broker selectors after their account has been downgraded to MEMBER.
router.get("/finance/archived-brokers", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT u.id, u.telegram_name, u.telegram_username, u.account_type,
       COALESCE(SUM(l.total_amount),0) AS total, COALESCE(SUM(l.paid_amount),0) AS paid
       FROM users u JOIN broker_lifts l ON l.broker_id = u.id
       WHERE u.account_type <> 'BROKER'::account_type
       GROUP BY u.id, u.telegram_name, u.telegram_username, u.account_type
       ORDER BY MAX(l.created_at) DESC`
    );
    return res.json({ success: true, brokers: result.rows });
  } catch (error) { return next(error); }
});

router.get("/finance/brokers/:id/lifts", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, total_amount, paid_amount, payment_method, created_at
       FROM broker_lifts WHERE broker_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return res.json({ success: true, lifts: result.rows });
  } catch (error) { return next(error); }
});

router.get("/finance/payments", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  try {
    const brokerId = String(req.query.brokerId || "").trim();
    const values = [];
    const filter = brokerId ? (values.push(brokerId), "WHERE p.broker_id = $1") : "";
    const result = await query(
      `SELECT p.*, u.telegram_name AS broker_name, u.telegram_username AS broker_username,
       recorder.telegram_name AS recorded_by_name, l.total_amount AS lift_total
       FROM broker_payments p JOIN users u ON u.id = p.broker_id
       LEFT JOIN users recorder ON recorder.id = p.recorded_by LEFT JOIN broker_lifts l ON l.id = p.lift_id
       ${filter} ORDER BY p.payment_date DESC LIMIT 150`, values
    );
    return res.json({ success: true, payments: result.rows });
  } catch (error) { return next(error); }
});

router.post("/finance/lifts", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  const brokerId = String(req.body?.brokerId || "");
  const amount = Number(req.body?.amount);
  const paymentMethod = String(req.body?.paymentMethod || "CASH");
  if (!brokerId || !Number.isFinite(amount) || amount <= 0 || !["CASH", "INSTALLMENTS"].includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: "بيانات الرفعة غير صالحة" });
  }
  try {
    const broker = await query(
      `SELECT id FROM users WHERE id = $1 AND account_type = 'BROKER'::account_type AND status = 'ACTIVE'::user_status`,
      [brokerId]
    );
    if (!broker.rows.length) return res.status(400).json({ success: false, message: "لا يمكن إضافة رفعة إلا لوسيط نشط" });
    const result = await query(
      `INSERT INTO broker_lifts (broker_id, total_amount, payment_method) VALUES ($1,$2,$3) RETURNING *`,
      [brokerId, amount, paymentMethod]
    );
    await query(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'CREATE_BROKER_LIFT','BROKER_LIFT',$2,$3::jsonb)`, [req.user.sub, result.rows[0].id, JSON.stringify({ brokerId, amount, paymentMethod })]);
    await notifyUser(brokerId, "تمت إضافة رفعة مالية", `تمت إضافة رفعة بقيمة ${amount} د.ع إلى حسابك.`);
    return res.status(201).json({ success: true, lift: result.rows[0] });
  } catch (error) { return next(error); }
});

router.post("/finance/payments", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  const brokerId = String(req.body?.brokerId || "");
  const liftId = req.body?.liftId || null;
  const amount = Number(req.body?.amount);
  const paymentType = String(req.body?.paymentType || "PAYMENT").slice(0, 30);
  if (!brokerId || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ success: false, message: "بيانات الدفعة غير صالحة" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const broker = await client.query(
      `SELECT id FROM users WHERE id = $1 AND account_type = 'BROKER'::account_type AND status = 'ACTIVE'::user_status FOR UPDATE`,
      [brokerId]
    );
    if (!broker.rows.length) throw new Error("لا يمكن تسجيل دفعة إلا لوسيط نشط");
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
    await client.query("COMMIT");
    await query(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'RECORD_BROKER_PAYMENT','BROKER_PAYMENT',$2,$3::jsonb)`, [req.user.sub, payment.rows[0].id, JSON.stringify({ brokerId, liftId, amount, paymentType })]);
    await notifyUser(brokerId, "تم تسجيل دفعة", `تم تسجيل دفعة بقيمة ${amount} د.ع.`);
    return res.status(201).json({ success: true, payment: payment.rows[0] });
  } catch (error) { await client.query("ROLLBACK"); return next(error); } finally { client.release(); }
});

router.delete("/finance/payments/:id", requireOwnerPermission("FINANCE"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await client.query("SELECT * FROM broker_payments WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!payment.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "الدفعة غير موجودة" }); }
    const item = payment.rows[0];
    if (item.lift_id) await client.query("UPDATE broker_lifts SET paid_amount = GREATEST(0, paid_amount - $1) WHERE id = $2", [item.amount, item.lift_id]);
    await client.query("DELETE FROM broker_payments WHERE id = $1", [item.id]);
    await client.query("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'REVERSE_BROKER_PAYMENT','BROKER_PAYMENT',$2,$3::jsonb)", [req.user.sub, item.id, JSON.stringify({ brokerId: item.broker_id, amount: item.amount })]);
    await client.query("COMMIT");
    await notifyUser(item.broker_id, "تم إلغاء دفعة", `تم إلغاء دفعة بقيمة ${item.amount} د.ع من السجل المالي.`);
    return res.json({ success: true });
  } catch (error) { await client.query("ROLLBACK"); return next(error); } finally { client.release(); }
});

router.patch("/users/:id/status", requireOwnerPermission("USERS"), async (req, res, next) => {
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
    await notifyUser(user.id,
      status === "SUSPENDED" ? "تم إيقاف حسابك" : "تم تفعيل حسابك",
      status === "SUSPENDED" ? "تم إيقاف الحساب من الإدارة. تواصل مع الدعم عند الحاجة." : "تم تفعيل الحساب من الإدارة.",
    );
    return res.json({ success: true, user });
  } catch (error) { return next(error); }
});

// This is deliberately Owner-only: it removes an ADMIN/BROKER from active
// role-based lists without deleting their account, applications, complaints,
// financial history, or audit trail.
router.patch("/users/:id/downgrade", requireRoles("OWNER"), async (req, res, next) => {
  if (req.params.id === req.user.sub) {
    return res.status(400).json({ success: false, message: "لا يمكنك تنزيل حساب Owner" });
  }
  try {
    const existing = await query(
      "SELECT id, telegram_name, telegram_username, account_type, role FROM users WHERE id = $1",
      [req.params.id]
    );
    if (!existing.rows.length) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    const previous = existing.rows[0];
    if (!["ADMIN", "BROKER"].includes(previous.account_type) || previous.role !== "MEMBER") {
      return res.status(400).json({ success: false, message: "يمكن تنزيل حسابات الادمن أو الوسطاء فقط" });
    }
    const result = await query(
      `UPDATE users SET account_type = 'MEMBER'::account_type, updated_at = NOW() WHERE id = $1
       RETURNING id, telegram_name, telegram_username, account_type, role, status, is_verified`,
      [previous.id]
    );
    const user = result.rows[0];
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1,'DOWNGRADE_ACCOUNT','USER',$2,$3::jsonb)`,
      [req.user.sub, user.id, JSON.stringify({ fromAccountType: previous.account_type, toAccountType: "MEMBER", preservedHistory: true })]
    );
    await notifyUser(user.id, "تم تنزيل نوع الحساب", `تم تحويل حسابك من ${previous.account_type === "ADMIN" ? "ادمن" : "وسيط"} إلى عضو. جميع بياناتك السابقة محفوظة.`);
    return res.json({ success: true, user, previousAccountType: previous.account_type });
  } catch (error) { return next(error); }
});

router.patch("/requests/:id/review", requireOwnerPermission("REQUESTS"), async (req, res, next) => {
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
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'REVIEW_APPLICATION', 'REQUEST', $2, $3::jsonb)`,
      [req.user.sub, request.id, JSON.stringify({ decision, note })]
    );
    await client.query("COMMIT");
    await notifyUser(request.user_id, title, body);
    return res.json({ success: true, request: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/complaints", requireOwnerPermission("COMPLAINTS"), async (req, res, next) => {
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

router.get("/complaints/:id", requireOwnerPermission("COMPLAINTS"), async (req, res, next) => {
  try {
    const complaint = await query(
      `SELECT c.*,
        a.telegram_id AS complainant_telegram_id, a.telegram_name AS complainant_name,
        a.telegram_username AS complainant_username, a.account_type AS complainant_account_type,
        t.telegram_id AS target_telegram_id, t.telegram_name AS target_name,
        t.telegram_username AS target_username, t.account_type AS target_account_type,
        assignee.telegram_name AS assignee_name, assignee.telegram_username AS assignee_username
       FROM complaints c
       JOIN users a ON a.id = c.complainant_id
       JOIN users t ON t.id = c.target_user_id
       LEFT JOIN users assignee ON assignee.id = c.assigned_to
       WHERE c.id = $1`,
      [req.params.id]
    );
    if (!complaint.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    const files = await query(
      `SELECT id, original_name, mime_type, file_size, sha256_hash, created_at
       FROM complaint_files WHERE complaint_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    const messages = await query(
      `SELECT m.id, m.body, m.created_at, u.telegram_name, u.telegram_username, u.role, u.account_type
       FROM complaint_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.complaint_id = $1 ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    const assistants = req.user.role === "OWNER" ? await query(
      `SELECT u.id, u.telegram_name, u.telegram_username FROM users u
       JOIN assistant_permissions ap ON ap.assistant_id = u.id AND ap.permission = 'COMPLAINTS'
       WHERE u.role = 'OWNER_ASSISTANT'::user_role AND u.status = 'ACTIVE'::user_status
       GROUP BY u.id ORDER BY u.telegram_name NULLS LAST`,
    ) : { rows: [] };
    return res.json({ success: true, complaint: { ...complaint.rows[0], files: files.rows, messages: messages.rows, assistants: assistants.rows } });
  } catch (error) { return next(error); }
});

router.get("/complaints/:complaintId/files/:fileId", requireOwnerPermission("COMPLAINTS"), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT f.original_name, f.mime_type, f.storage_path, f.telegram_file_id
       FROM complaint_files f
       JOIN complaints c ON c.id = f.complaint_id
       WHERE f.id = $1 AND c.id = $2`,
      [req.params.fileId, req.params.complaintId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "مرفق الشكوى غير موجود" });
    const file = result.rows[0];
    if (file.telegram_file_id) return streamFromTelegram(file.telegram_file_id, file.mime_type, res);
    const absolutePath = path.resolve(file.storage_path);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ success: false, message: "هذا المرفق غير متاح حاليًا." });
    res.type(file.mime_type);
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    return res.sendFile(absolutePath);
  } catch (error) { return next(error); }
});

router.patch("/complaints/:id", requireOwnerPermission("COMPLAINTS"), async (req, res, next) => {
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
    await notifyUser(complaint.complainant_id, "تم تحديث الشكوى", note || `تم تغيير حالة الشكوى إلى ${status}.`);
    return res.json({ success: true, complaint });
  } catch (error) { return next(error); }
});

router.post("/complaints/:id/messages", requireOwnerPermission("COMPLAINTS"), async (req, res, next) => {
  const body = String(req.body?.body || "").trim();
  if (body.length < 1 || body.length > 5000) return res.status(400).json({ success: false, message: "اكتب رسالة بين 1 و5000 حرف" });
  try {
    const complaint = await query("SELECT complainant_id FROM complaints WHERE id = $1", [req.params.id]);
    if (!complaint.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    const result = await query(
      "INSERT INTO complaint_messages (complaint_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at",
      [req.params.id, req.user.sub, body]
    );
    await query("UPDATE complaints SET status = 'UNDER_REVIEW', updated_at = NOW() WHERE id = $1", [req.params.id]);
    await notifyUser(complaint.rows[0].complainant_id, "رسالة جديدة بخصوص شكواك", body);
    await query(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'REPLY_TO_COMPLAINT','COMPLAINT',$2,$3::jsonb)`, [req.user.sub, req.params.id, JSON.stringify({ length: body.length })]);
    return res.status(201).json({ success: true, message: result.rows[0] });
  } catch (error) { return next(error); }
});

router.patch("/complaints/:id/assignment", requireRoles("OWNER"), async (req, res, next) => {
  const assistantId = String(req.body?.assistantId || "").trim() || null;
  try {
    if (assistantId) {
      const assistant = await query(
        `SELECT u.id FROM users u JOIN assistant_permissions ap ON ap.assistant_id = u.id
         WHERE u.id = $1 AND u.role = 'OWNER_ASSISTANT'::user_role AND ap.permission = 'COMPLAINTS'`,
        [assistantId]
      );
      if (!assistant.rows.length) return res.status(400).json({ success: false, message: "المساعد المختار غير مخوّل بإدارة الشكاوى" });
    }
    const result = await query("UPDATE complaints SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING *", [assistantId, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    if (assistantId) await notifyUser(assistantId, "تم إسناد شكوى إليك", "لديك شكوى جديدة تحتاج إلى مراجعة.");
    await query(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'ASSIGN_COMPLAINT','COMPLAINT',$2,$3::jsonb)`, [req.user.sub, req.params.id, JSON.stringify({ assistantId })]);
    return res.json({ success: true, complaint: result.rows[0] });
  } catch (error) { return next(error); }
});

module.exports = router;
