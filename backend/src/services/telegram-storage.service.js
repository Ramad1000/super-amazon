const fs = require("fs");
const { Readable } = require("stream");
const { TELEGRAM_BOT_TOKEN, TELEGRAM_STORAGE_CHAT_ID } = require("../config/env");

function storageError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  // Telegram descriptions are safe to show and make configuration problems
  // actionable (for example: "chat not found" or "bot is not a member").
  const detail = String(message || "").replace(/[\r\n]+/g, " ").slice(0, 180);
  error.publicMessage = `تعذر حفظ المرفقات في قناة Telegram.${detail ? ` السبب: ${detail}.` : ""} تأكد من TELEGRAM_STORAGE_CHAT_ID ومن صلاحية البوت في القناة.`;
  return error;
}

function configured(chatId = TELEGRAM_STORAGE_CHAT_ID) {
  return Boolean(TELEGRAM_BOT_TOKEN && chatId);
}

async function telegramApi(method, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) throw storageError("لم يتم إعداد رمز بوت Telegram");
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw storageError(data.description || "تعذر الاتصال بتخزين Telegram");
  return data.result;
}

async function uploadToTelegram(file, caption = "", chatId = TELEGRAM_STORAGE_CHAT_ID) {
  if (!configured(chatId)) throw storageError("لم يتم إعداد قناة تخزين Telegram في الخادم");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", String(caption).slice(0, 900));
  form.set("document", new Blob([fs.readFileSync(file.path)], { type: file.mimetype }), file.originalname);
  const message = await telegramApi("sendDocument", { method: "POST", body: form });
  const document = message.document;
  if (!document?.file_id) throw storageError("لم يعُد Telegram بمعرّف المرفق");
  return { fileId: document.file_id, chatId: String(chatId), messageId: message.message_id };
}

async function streamFromTelegram(fileId, mimeType, res) {
  if (!configured()) throw storageError("تخزين Telegram غير مُعدّ");
  const details = await telegramApi(`getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!details?.file_path) throw storageError("تعذر العثور على المرفق في Telegram");
  const response = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${details.file_path}`);
  if (!response.ok || !response.body) throw storageError("تعذر تنزيل المرفق من Telegram");
  res.type(mimeType || "application/octet-stream");
  Readable.fromWeb(response.body).pipe(res);
}

module.exports = { configured, uploadToTelegram, streamFromTelegram };
