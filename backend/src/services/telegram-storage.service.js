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

function extractTelegramFileId(message) {
  // Telegram may return a document, but depending on the sent media type it
  // can also return video/photo/animation/audio. Keep the storage layer
  // compatible with all valid complaint evidence formats.
  const candidates = [
    message?.document,
    message?.video,
    message?.animation,
    message?.audio,
    message?.voice,
    message?.video_note,
    message?.sticker,
  ];
  if (Array.isArray(message?.photo) && message.photo.length) candidates.push(message.photo.at(-1));
  return candidates.find((file) => file?.file_id)?.file_id || null;
}

async function uploadToTelegram(file, caption = "", chatId = TELEGRAM_STORAGE_CHAT_ID) {
  if (!configured(chatId)) throw storageError("لم يتم إعداد قناة تخزين Telegram في الخادم");
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", String(caption).slice(0, 900));
  form.set("document", new Blob([fs.readFileSync(file.path)], { type: file.mimetype }), file.originalname);
  const message = await telegramApi("sendDocument", { method: "POST", body: form });
  const fileId = extractTelegramFileId(message);
  if (!fileId) {
    const messageFields = Object.keys(message || {}).join(", ") || "لا توجد بيانات رسالة";
    throw storageError(`لم يعُد Telegram بمعرّف المرفق (حقول الاستجابة: ${messageFields})`);
  }
  return { fileId, chatId: String(chatId), messageId: message.message_id };
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

async function inspectStorage() {
  if (!configured()) throw storageError("لم يتم إعداد TELEGRAM_BOT_TOKEN أو TELEGRAM_STORAGE_CHAT_ID");
  const bot = await telegramApi("getMe");
  const encodedChatId = encodeURIComponent(String(TELEGRAM_STORAGE_CHAT_ID));
  const chat = await telegramApi(`getChat?chat_id=${encodedChatId}`);
  const membership = await telegramApi(`getChatMember?chat_id=${encodedChatId}&user_id=${bot.id}`);
  return {
    botUsername: bot.username ? `@${bot.username}` : bot.first_name || "البوت",
    chatTitle: chat.title || chat.username || "القناة",
    botStatus: membership.status || "unknown",
    canPost: ["administrator", "creator", "owner"].includes(membership.status),
  };
}

module.exports = { configured, uploadToTelegram, streamFromTelegram, inspectStorage };
