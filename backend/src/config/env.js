const dotenv = require("dotenv");

dotenv.config();
// Local OAuth credentials are kept outside the shared base configuration.
dotenv.config({ path: ".env.telegram.local", override: true }); // local deployment overrides

module.exports = {
  PORT: Number(process.env.PORT || 4000),
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "15m",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:5173",
  OWNER_SETUP_KEY: process.env.OWNER_SETUP_KEY || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_STORAGE_CHAT_ID: process.env.TELEGRAM_STORAGE_CHAT_ID || "",
  TELEGRAM_CLIENT_ID: process.env.TELEGRAM_CLIENT_ID || "",
  TELEGRAM_CLIENT_SECRET: process.env.TELEGRAM_CLIENT_SECRET || "",
  TELEGRAM_AUTH_MAX_AGE_SECONDS: Number(process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400),
  UPLOAD_DIR: process.env.UPLOAD_DIR || "./uploads",
};
