const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { query } = require("../db/database");
const { auth } = require("../middleware/auth");
const { notifyUser, notifyRole, notifyAssistantsWithPermission } = require("../services/notification.service");
const { uploadToTelegram } = require("../services/telegram-storage.service");

const router = express.Router();
router.use(auth);

const uploadDirectory = path.resolve(__dirname, "../../uploads");
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".3gp", ".3gpp"]);
const VIDEO_MIME_TYPES = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".3gp": "video/3gpp", ".3gpp": "video/3gpp" };

function normalizedMimeType(file) {
  if (file.mimetype.startsWith("video/") || file.mimetype.startsWith("image/")) return file.mimetype;
  return VIDEO_MIME_TYPES[path.extname(file.originalname || "").toLowerCase()] || file.mimetype;
}

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, uploadDirectory),
  filename: (req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    const isImage = file.mimetype.startsWith("image/");
    const isVideo = file.mimetype.startsWith("video/") || VIDEO_EXTENSIONS.has(extension);
    if (isImage || isVideo) return callback(null, true);
    const error = new Error("يمكن رفع الصور أو ملفات الفيديو MP4 وWebM وMOV و3GP فقط");
    error.statusCode = 400;
    return callback(error);
  },
});

router.get("/targets", async (req, res, next) => {
  try {
    const type = String(req.query.type || "").toUpperCase();
    const params = [req.user.sub];
    let filter = "";
    if (["ADMIN", "BROKER"].includes(type)) {
      params.push(type);
      filter = " AND account_type = $2::account_type";
    }
    const result = await query(
      `SELECT id, telegram_username, telegram_name, account_type
       FROM users WHERE id <> $1 AND status = 'ACTIVE'::user_status AND is_verified = true
       AND account_type IN ('ADMIN'::account_type, 'BROKER'::account_type)${filter}
       ORDER BY telegram_name NULLS LAST, telegram_username NULLS LAST`,
      params
    );
    return res.json({ success: true, targets: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT c.*, u.telegram_name AS target_name, u.telegram_username AS target_username
       FROM complaints c JOIN users u ON u.id = c.target_user_id
       WHERE c.complainant_id = $1 ORDER BY c.created_at DESC`,
      [req.user.sub]
    );
    return res.json({ success: true, complaints: result.rows });
  } catch (error) {
    return next(error);
  }
});

router.get("/me/:id", async (req, res, next) => {
  try {
    const complaint = await query(
      `SELECT c.*, u.telegram_name AS target_name, u.telegram_username AS target_username
       FROM complaints c JOIN users u ON u.id = c.target_user_id
       WHERE c.id = $1 AND c.complainant_id = $2`,
      [req.params.id, req.user.sub]
    );
    if (!complaint.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    const messages = await query(
      `SELECT m.id, m.body, m.created_at, u.telegram_name, u.telegram_username, u.role, u.account_type
       FROM complaint_messages m JOIN users u ON u.id = m.sender_id
       WHERE m.complaint_id = $1 ORDER BY m.created_at ASC`, [req.params.id]
    );
    return res.json({ success: true, complaint: { ...complaint.rows[0], messages: messages.rows } });
  } catch (error) { return next(error); }
});

router.post("/:id/messages", async (req, res, next) => {
  const body = String(req.body?.body || "").trim();
  if (body.length < 1 || body.length > 5000) return res.status(400).json({ success: false, message: "اكتب رسالة بين 1 و5000 حرف" });
  try {
    const complaint = await query("SELECT id, target_user_id FROM complaints WHERE id = $1 AND complainant_id = $2", [req.params.id, req.user.sub]);
    if (!complaint.rows.length) return res.status(404).json({ success: false, message: "الشكوى غير موجودة" });
    const result = await query("INSERT INTO complaint_messages (complaint_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at", [req.params.id, req.user.sub, body]);
    await query("UPDATE complaints SET status = 'UNDER_REVIEW', updated_at = NOW() WHERE id = $1", [req.params.id]);
    await notifyRole("OWNER", "رد جديد على شكوى", "أرسل مقدم الشكوى رسالة جديدة للمراجعة.");
    await notifyAssistantsWithPermission("COMPLAINTS", "رد جديد على شكوى", "أرسل مقدم الشكوى رسالة جديدة للمراجعة.");
    return res.status(201).json({ success: true, message: result.rows[0] });
  } catch (error) { return next(error); }
});

router.post("/", upload.array("attachments", 4), async (req, res, next) => {
  let complaintId = null;
  try {
    const targetUserId = String(req.body?.targetUserId || "");
    const targetType = String(req.body?.targetType || "").toUpperCase();
    const body = String(req.body?.body || "").trim();
    if (!targetUserId || !["ADMIN", "BROKER"].includes(targetType) || body.length < 5 || body.length > 5000) {
      return res.status(400).json({ success: false, message: "بيانات الشكوى غير مكتملة" });
    }
    if (targetUserId === req.user.sub) {
      return res.status(400).json({ success: false, message: "لا يمكنك تقديم شكوى على حسابك" });
    }
    const target = await query(
      `SELECT id FROM users WHERE id = $1 AND account_type = $2::account_type
       AND status = 'ACTIVE'::user_status AND is_verified = true`,
      [targetUserId, targetType]
    );
    if (!target.rows.length) return res.status(404).json({ success: false, message: "الحساب المختار غير متاح" });

    const created = await query(
      `INSERT INTO complaints (complainant_id, target_user_id, target_type, body)
       VALUES ($1,$2,$3::account_type,$4) RETURNING *`,
      [req.user.sub, targetUserId, targetType, body]
    );
    complaintId = created.rows[0].id;
    for (const file of req.files || []) {
      const mimeType = normalizedMimeType(file);
      const telegramFile = await uploadToTelegram({ ...file, mimetype: mimeType }, `Super Amazon • شكوى جديدة • ${targetType}`);
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
      await query(
        `INSERT INTO complaint_files (complaint_id, original_name, stored_name, mime_type, file_size, storage_path, sha256_hash, telegram_file_id, telegram_chat_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [created.rows[0].id, file.originalname, file.filename, mimeType, file.size, file.path, hash, telegramFile.fileId, telegramFile.chatId]
      );
    }
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'CREATE_COMPLAINT', 'COMPLAINT', $2, $3::jsonb)`,
      [req.user.sub, created.rows[0].id, JSON.stringify({ targetUserId, targetType })]
    );
    await notifyUser(req.user.sub, "تم استلام الشكوى", "تم إرسال شكواك إلى الإدارة وسيتم إشعارك عند تحديث حالتها.");
    await notifyRole("OWNER", "شكوى جديدة", `تم استلام شكوى جديدة ضد حساب ${targetType}.`);
    await notifyAssistantsWithPermission("COMPLAINTS", "شكوى جديدة", `تم استلام شكوى جديدة ضد حساب ${targetType}.`);
    return res.status(201).json({ success: true, complaint: created.rows[0] });
  } catch (error) {
    if (complaintId) {
      await query("DELETE FROM complaints WHERE id = $1", [complaintId]).catch(() => {});
    }
    return next(error);
  }
});

module.exports = router;
