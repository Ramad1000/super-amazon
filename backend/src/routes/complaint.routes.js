const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { query } = require("../db/database");
const { auth } = require("../middleware/auth");
const { notifyUser, notifyRole } = require("../services/notification.service");

const router = express.Router();
router.use(auth);

const uploadDirectory = path.resolve(__dirname, "../../uploads");
const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, uploadDirectory),
  filename: (req, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, callback) => {
    if (file.mimetype.startsWith("image/") || ["video/mp4", "video/webm", "video/quicktime"].includes(file.mimetype)) return callback(null, true);
    const error = new Error("يمكن رفع الصور أو فيديو MP4/WebM فقط");
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

router.post("/", upload.array("attachments", 4), async (req, res, next) => {
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
    for (const file of req.files || []) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
      await query(
        `INSERT INTO complaint_files (complaint_id, original_name, stored_name, mime_type, file_size, storage_path, sha256_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [created.rows[0].id, file.originalname, file.filename, file.mimetype, file.size, file.path, hash]
      );
    }
    await query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details)
       VALUES ($1, 'CREATE_COMPLAINT', 'COMPLAINT', $2, $3::jsonb)`,
      [req.user.sub, created.rows[0].id, JSON.stringify({ targetUserId, targetType })]
    );
    await notifyUser(req.user.sub, "تم استلام الشكوى", "تم إرسال شكواك إلى الإدارة وسيتم إشعارك عند تحديث حالتها.");
    await notifyRole("OWNER", "شكوى جديدة", `تم استلام شكوى جديدة ضد حساب ${targetType}.`);
    await notifyRole("OWNER_ASSISTANT", "شكوى جديدة", `تم استلام شكوى جديدة ضد حساب ${targetType}.`);
    return res.status(201).json({ success: true, complaint: created.rows[0] });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
