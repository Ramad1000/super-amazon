const crypto = require("crypto");
const zlib = require("zlib");
const { query, pool } = require("../db/database");
const { BACKUP_ENCRYPTION_KEY, BACKUP_SCHEDULE_HOUR, BACKUP_TIMEZONE } = require("../config/env");
const { uploadToTelegram, downloadFromTelegram, inspectStorage } = require("./telegram-storage.service");

const MAGIC = Buffer.from("SUPER_AMAZON_BACKUP_V1\n");
let backupRunning = false;

function backupError(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; return error; }
function encryptionKey() {
  if (!BACKUP_ENCRYPTION_KEY || BACKUP_ENCRYPTION_KEY.length < 24) throw backupError("لم يتم إعداد BACKUP_ENCRYPTION_KEY الآمن في Render", 503);
  return crypto.createHash("sha256").update(BACKUP_ENCRYPTION_KEY).digest();
}
function encrypt(input) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const header = Buffer.from(`${JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") })}\n`);
  return Buffer.concat([MAGIC, header, encrypted]);
}
function decrypt(input) {
  if (!input.subarray(0, MAGIC.length).equals(MAGIC)) throw backupError("ملف النسخة غير صالح أو من إصدار قديم غير قابل للاستعادة", 422);
  const headerEnd = input.indexOf("\n", MAGIC.length);
  if (headerEnd < 0) throw backupError("رأس ملف النسخة غير صالح", 422);
  let header; try { header = JSON.parse(input.subarray(MAGIC.length, headerEnd).toString("utf8")); } catch { throw backupError("رأس تشفير النسخة غير صالح", 422); }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(header.iv, "base64"));
    decipher.setAuthTag(Buffer.from(header.tag, "base64"));
    return Buffer.concat([decipher.update(input.subarray(headerEnd + 1)), decipher.final()]);
  } catch { throw backupError("تعذر فك تشفير النسخة: تحقق من BACKUP_ENCRYPTION_KEY", 422); }
}
async function setting(key) { const result = await query("SELECT value FROM system_settings WHERE key = $1", [key]); return result.rows[0]?.value || null; }
async function loadBackupData() {
  const [users, requests, requestFiles, complaints, complaintFiles, complaintMessages, brokerFinance, brokerLifts, brokerPayments, announcements, notifications, assistantPermissions, auditLogs, settings] = await Promise.all([
    query("SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status, is_verified, created_at, updated_at FROM users ORDER BY created_at"),
    query("SELECT * FROM requests ORDER BY created_at"), query("SELECT * FROM request_files ORDER BY created_at"),
    query("SELECT * FROM complaints ORDER BY created_at"), query("SELECT * FROM complaint_files ORDER BY created_at"), query("SELECT * FROM complaint_messages ORDER BY created_at"),
    query("SELECT * FROM broker_finance ORDER BY created_at"), query("SELECT * FROM broker_lifts ORDER BY created_at"), query("SELECT * FROM broker_payments ORDER BY payment_date"),
    query("SELECT * FROM announcements ORDER BY created_at"), query("SELECT * FROM notifications ORDER BY created_at"), query("SELECT * FROM assistant_permissions ORDER BY assistant_id, permission"), query("SELECT * FROM audit_logs ORDER BY created_at"), query("SELECT * FROM system_settings ORDER BY key"),
  ]);
  return { users: users.rows, requests: requests.rows, requestFiles: requestFiles.rows, complaints: complaints.rows, complaintFiles: complaintFiles.rows, complaintMessages: complaintMessages.rows, brokerFinance: brokerFinance.rows, brokerLifts: brokerLifts.rows, brokerPayments: brokerPayments.rows, announcements: announcements.rows, notifications: notifications.rows, assistantPermissions: assistantPermissions.rows, auditLogs: auditLogs.rows, settings: settings.rows };
}
async function createBackup({ actorUserId = null, trigger = "MANUAL" } = {}) {
  if (backupRunning) throw backupError("توجد نسخة احتياطية قيد الإنشاء بالفعل", 409);
  backupRunning = true; let backupId = null;
  try {
    const channelId = (await setting("backup_telegram_channel"))?.channelId;
    if (!channelId) throw backupError("لم يتم تحديد قناة النسخ الاحتياطي من لوحة Owner");
    const channel = await inspectStorage(channelId);
    if (!channel.canPost) throw backupError("البوت لا يملك صلاحية الإرسال في قناة النسخ الاحتياطي", 503);
    const created = await query("INSERT INTO backup_logs (started_at, status, trigger) VALUES (NOW(), 'RUNNING', $1) RETURNING id", [trigger]);
    backupId = created.rows[0].id;
    const payload = Buffer.from(JSON.stringify({ format: "super-amazon-backup-v2", generatedAt: new Date().toISOString(), encrypted: true, data: await loadBackupData() }));
    const encrypted = encrypt(zlib.gzipSync(payload, { level: 9 }));
    const sha256 = crypto.createHash("sha256").update(encrypted).digest("hex");
    const filename = `super-amazon-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.saenc`;
    const temporaryPath = require("path").join(require("os").tmpdir(), filename);
    require("fs").writeFileSync(temporaryPath, encrypted);
    let telegramFile;
    try { telegramFile = await uploadToTelegram({ path: temporaryPath, originalname: filename, mimetype: "application/octet-stream", size: encrypted.length }, "Super Amazon • نسخة احتياطية مشفّرة AES-256-GCM", channelId); }
    finally { require("fs").unlink(temporaryPath, () => {}); }
    const saved = await query("UPDATE backup_logs SET finished_at = NOW(), status = 'SUCCESS', file_size = $1, sha256_hash = $2, telegram_message_id = $3, telegram_file_id = $4, encryption_algorithm = 'AES-256-GCM' WHERE id = $5 RETURNING *", [encrypted.length, sha256, String(telegramFile.messageId), telegramFile.fileId, backupId]);
    await query("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'CREATE_BACKUP','BACKUP',$2,$3::jsonb)", [actorUserId, backupId, JSON.stringify({ trigger, sha256, encrypted: true })]);
    return saved.rows[0];
  } catch (error) {
    if (backupId) await query("UPDATE backup_logs SET finished_at = NOW(), status = 'FAILED', error_message = $1 WHERE id = $2", [String(error.message).slice(0, 1000), backupId]).catch(() => {});
    throw error;
  } finally { backupRunning = false; }
}
async function restoreBackup(backupId, actorUserId) {
  const backup = await query("SELECT * FROM backup_logs WHERE id = $1 AND status = 'SUCCESS'", [backupId]);
  const item = backup.rows[0];
  if (!item?.telegram_file_id) throw backupError("هذه النسخة قديمة ولا تحتوي معرّف ملف Telegram؛ لا يمكن استعادتها تلقائيًا", 422);
  const raw = await downloadFromTelegram(item.telegram_file_id);
  if (crypto.createHash("sha256").update(raw).digest("hex") !== item.sha256_hash) throw backupError("فشل التحقق من سلامة ملف النسخة", 422);
  let source; try { source = JSON.parse(zlib.gunzipSync(decrypt(raw)).toString("utf8")); } catch (error) { if (error.statusCode) throw error; throw backupError("بيانات النسخة غير صالحة", 422); }
  if (source?.format !== "super-amazon-backup-v2" || !source?.data?.users) throw backupError("تنسيق النسخة غير مدعوم", 422);
  const data = source.data; const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sessions; DELETE FROM assistant_permissions; DELETE FROM notifications; DELETE FROM audit_logs; DELETE FROM complaint_messages; DELETE FROM complaint_files; DELETE FROM request_files; DELETE FROM broker_payments; DELETE FROM broker_lifts; DELETE FROM broker_finance; DELETE FROM complaints; DELETE FROM requests; DELETE FROM announcements; DELETE FROM system_settings; DELETE FROM users;");
    const tables = [["users", data.users], ["requests", data.requests], ["complaints", data.complaints], ["request_files", data.requestFiles], ["complaint_files", data.complaintFiles], ["complaint_messages", data.complaintMessages], ["broker_finance", data.brokerFinance], ["broker_lifts", data.brokerLifts], ["broker_payments", data.brokerPayments], ["announcements", data.announcements], ["notifications", data.notifications], ["assistant_permissions", data.assistantPermissions], ["audit_logs", data.auditLogs], ["system_settings", data.settings]];
    for (const [table, rows] of tables) if (Array.isArray(rows) && rows.length) await client.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`, [JSON.stringify(rows)]);
    await client.query("SELECT setval(pg_get_serial_sequence('requests','request_number'), COALESCE((SELECT MAX(request_number) FROM requests), 1), true)");
    await client.query("SELECT setval(pg_get_serial_sequence('audit_logs','id'), COALESCE((SELECT MAX(id) FROM audit_logs), 1), true)");
    const restoredActor = await client.query("SELECT id FROM users WHERE id = $1", [actorUserId]);
    await client.query("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1,'RESTORE_BACKUP','BACKUP',$2,$3::jsonb)", [restoredActor.rows[0]?.id || null, backupId, JSON.stringify({ restoredAt: new Date().toISOString() })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
function localDateParts() { const values = new Intl.DateTimeFormat("en-CA", { timeZone: BACKUP_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(new Date()); return Object.fromEntries(values.map((part) => [part.type, part.value])); }
async function runScheduledBackupIfDue() {
  const time = localDateParts(); const today = `${time.year}-${time.month}-${time.day}`;
  if (Number(time.hour) < BACKUP_SCHEDULE_HOUR) return;
  const last = await setting("last_automatic_backup");
  if (last?.date === today) return;
  const channel = await setting("backup_telegram_channel"); if (!channel?.channelId) return;
  await createBackup({ trigger: "AUTOMATIC" });
  await query("INSERT INTO system_settings (key,value,updated_at) VALUES ('last_automatic_backup',$1::jsonb,NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [JSON.stringify({ date: today })]);
}
function startBackupScheduler() { const run = () => runScheduledBackupIfDue().catch((error) => console.error("Automatic backup:", error.message)); run(); return setInterval(run, 5 * 60 * 1000); }
module.exports = { createBackup, restoreBackup, startBackupScheduler };
