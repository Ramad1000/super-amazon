const { query } = require("../db/database");
const { TELEGRAM_BOT_TOKEN } = require("../config/env");

function messageText(title, body) {
  return `🔔 ${String(title || "إشعار جديد")}\n\n${String(body || "")}`.slice(0, 4000);
}

async function sendTelegramNotification(userId, title, body) {
  if (!TELEGRAM_BOT_TOKEN || !userId) return { delivered: false, reason: "BOT_NOT_CONFIGURED" };
  try {
    const result = await query("SELECT telegram_id FROM users WHERE id = $1", [userId]);
    const chatId = result.rows[0]?.telegram_id;
    if (!chatId) return { delivered: false, reason: "NO_TELEGRAM_ID" };
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: messageText(title, body), disable_web_page_preview: true }),
    });
    if (!response.ok) {
      console.warn("Telegram notification was not delivered", response.status);
      return { delivered: false, reason: "TELEGRAM_REJECTED" };
    }
    return { delivered: true };
  } catch (error) {
    console.warn("Telegram notification failed", error.message);
    return { delivered: false, reason: "TELEGRAM_UNAVAILABLE" };
  }
}

async function notifyUser(userId, title, body) {
  await query("INSERT INTO notifications (user_id, title, body) VALUES ($1,$2,$3)", [userId, title, body]);
  return sendTelegramNotification(userId, title, body);
}

async function notifyAudience(audience, title, body) {
  const params = [];
  let filter = "";
  if (audience && audience !== "ALL") { params.push(audience); filter = " AND account_type = $1::account_type"; }
  const result = await query(`SELECT id FROM users WHERE status = 'ACTIVE'::user_status${filter}`, params);
  for (const user of result.rows) await notifyUser(user.id, title, body);
  return result.rows.length;
}

async function notifyRole(role, title, body) {
  const result = await query("SELECT id FROM users WHERE status = 'ACTIVE'::user_status AND role = $1::user_role", [role]);
  for (const user of result.rows) await notifyUser(user.id, title, body);
  return result.rows.length;
}

async function notifyAssistantsWithPermission(permission, title, body) {
  const result = await query(
    `SELECT u.id FROM users u JOIN assistant_permissions ap ON ap.assistant_id = u.id
     WHERE u.status = 'ACTIVE'::user_status AND u.role = 'OWNER_ASSISTANT'::user_role AND ap.permission = $1`,
    [permission]
  );
  for (const user of result.rows) await notifyUser(user.id, title, body);
  return result.rows.length;
}

module.exports = { notifyUser, notifyAudience, notifyRole, notifyAssistantsWithPermission, sendTelegramNotification };
