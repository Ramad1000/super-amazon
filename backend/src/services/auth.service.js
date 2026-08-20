const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { query } = require("../db/database");
const {
  JWT_EXPIRES_IN,
  JWT_SECRET,
  TELEGRAM_CLIENT_ID,
  TELEGRAM_CLIENT_SECRET,
  TELEGRAM_AUTH_MAX_AGE_SECONDS,
  TELEGRAM_BOT_TOKEN,
} = require("../config/env");

function clientError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

let jwksCache = { keys: [], expiresAt: 0 };
const telegramAttempts = new Map();

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function safeReturnUrl(value) {
  const url = new URL(String(value || ""));
  const localDevelopment = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:")) {
    throw clientError("رابط العودة غير صالح");
  }
  return url.origin;
}

function beginTelegramAuthorization(returnUrl) {
  if (!TELEGRAM_CLIENT_ID || !TELEGRAM_CLIENT_SECRET) {
    const error = new Error("Telegram authentication is not configured");
    error.statusCode = 503;
    throw error;
  }

  const origin = safeReturnUrl(returnUrl);
  const state = base64Url(crypto.randomBytes(32));
  const verifier = base64Url(crypto.randomBytes(48));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  // BotFather's Domain setting registers the site origin. Use that exact
  // origin as the OAuth redirect URI, then exchange the returned code through
  // our API from the application page.
  const callbackUrl = origin;

  for (const [key, attempt] of telegramAttempts) {
    if (Date.now() - attempt.createdAt > 10 * 60 * 1000) telegramAttempts.delete(key);
  }
  telegramAttempts.set(state, { callbackUrl, createdAt: Date.now(), origin, verifier });

  const params = new URLSearchParams({
    client_id: TELEGRAM_CLIENT_ID,
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://oauth.telegram.org/auth?${params.toString()}`;
}

async function completeTelegramAuthorization({ code, state, metadata = {} }) {
  const attempt = telegramAttempts.get(state);
  telegramAttempts.delete(state);
  if (!attempt || !code || Date.now() - attempt.createdAt > 10 * 60 * 1000) {
    throw clientError("انتهت جلسة تسجيل Telegram. أعد المحاولة.");
  }

  const basicAuth = Buffer.from(`${TELEGRAM_CLIENT_ID}:${TELEGRAM_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://oauth.telegram.org/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: attempt.callbackUrl,
      client_id: TELEGRAM_CLIENT_ID,
      code_verifier: attempt.verifier,
    }),
  });

  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.id_token) {
    throw clientError("تعذر إكمال تسجيل Telegram");
  }

  const result = await loginWithTelegram({ id_token: tokens.id_token }, metadata);
  return { ...result, returnUrl: attempt.origin };
}

async function getTelegramPublicKey(keyId) {
  if (Date.now() >= jwksCache.expiresAt) {
    const response = await fetch("https://oauth.telegram.org/.well-known/jwks.json");
    if (!response.ok) {
      throw new Error("Unable to load Telegram signing keys");
    }
    const body = await response.json();
    jwksCache = { keys: Array.isArray(body.keys) ? body.keys : [], expiresAt: Date.now() + 60 * 60 * 1000 };
  }

  const key = jwksCache.keys.find((item) => item.kid === keyId);
  if (!key) {
    throw clientError("تعذر التحقق من مفتاح Telegram");
  }

  return crypto.createPublicKey({ key, format: "jwk" });
}

async function verifyTelegramLogin(payload) {
  if (!payload?.id_token) {
    return verifyLegacyTelegramLogin(payload);
  }

  if (!TELEGRAM_CLIENT_ID) {
    const error = new Error("Telegram authentication is not configured");
    error.statusCode = 503;
    throw error;
  }

  if (!payload?.id_token) {
    throw clientError("بيانات Telegram غير مكتملة");
  }

  const decoded = jwt.decode(payload.id_token, { complete: true });
  if (!decoded?.header?.kid) {
    throw clientError("رمز Telegram غير صالح");
  }

  const publicKey = await getTelegramPublicKey(decoded.header.kid);
  let claims;
  try {
    claims = jwt.verify(payload.id_token, publicKey, {
      algorithms: ["RS256"],
      audience: TELEGRAM_CLIENT_ID,
      issuer: "https://oauth.telegram.org",
    });
  } catch {
    throw clientError("تعذر التحقق من هوية Telegram");
  }

  if (!claims.id || !claims.sub) {
    throw clientError("بيانات حساب Telegram غير مكتملة");
  }

  return {
    telegramId: String(claims.id),
    telegramUsername: claims.preferred_username || null,
    telegramName: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || null,
  };
}

function verifyLegacyTelegramLogin(payload) {
  if (!TELEGRAM_BOT_TOKEN) {
    const error = new Error("Telegram authentication is not configured");
    error.statusCode = 503;
    throw error;
  }

  const { hash, id, auth_date: authDate, ...data } = payload || {};
  if (!hash || !id || !authDate) {
    throw clientError("بيانات Telegram غير مكتملة");
  }

  const authDateNumber = Number(authDate);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(authDateNumber) || now - authDateNumber > TELEGRAM_AUTH_MAX_AGE_SECONDS || authDateNumber > now + 60) {
    throw clientError("انتهت صلاحية بيانات Telegram");
  }

  const dataCheckString = Object.entries({ id, auth_date: authDate, ...data })
    .filter(([key, value]) => key !== "hash" && value !== undefined && value !== null)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHash("sha256").update(TELEGRAM_BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const received = Buffer.from(String(hash), "hex");
  const expected = Buffer.from(expectedHash, "hex");

  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw clientError("تعذر التحقق من هوية Telegram");
  }

  return {
    telegramId: String(id),
    telegramUsername: data.username || null,
    telegramName: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
  };
}

async function loginWithTelegram(payload, metadata = {}) {
  if (!JWT_SECRET) {
    const error = new Error("JWT is not configured");
    error.statusCode = 503;
    throw error;
  }

  // Authentication verification may be asynchronous when Telegram returns an
  // OpenID token. Await it as well for the legacy widget flow so validation
  // errors reach the route error handler instead of becoming an unhandled
  // rejected promise.
  const telegram = await verifyTelegramLogin(payload);
  let result = await query(
    `SELECT id, telegram_id, telegram_username, telegram_name, account_type, role, status, is_verified
     FROM users WHERE telegram_id = $1 LIMIT 1`,
    [telegram.telegramId]
  );

  let user;
  if (result.rows.length) {
    user = result.rows[0];
    await query(
      `UPDATE users SET telegram_username = $1, telegram_name = $2, updated_at = NOW() WHERE id = $3`,
      [telegram.telegramUsername, telegram.telegramName, user.id]
    );
    user.telegram_username = telegram.telegramUsername;
    user.telegram_name = telegram.telegramName;
  } else {
    result = await query(
      `INSERT INTO users (telegram_id, telegram_username, telegram_name, account_type, role, status, is_verified)
       VALUES ($1, $2, $3, 'MEMBER'::account_type, 'MEMBER'::user_role, 'ACTIVE'::user_status, true)
       RETURNING id, telegram_id, telegram_username, telegram_name, account_type, role, status, is_verified`,
      [telegram.telegramId, telegram.telegramUsername, telegram.telegramName]
    );
    user = result.rows[0];
  }

  if (user.status === "SUSPENDED") {
    const error = new Error("هذا الحساب موقوف");
    error.statusCode = 403;
    throw error;
  }

  const session = await query(
    `INSERT INTO sessions (user_id, user_agent, ip_address) VALUES ($1, $2, $3) RETURNING id`,
    [user.id, metadata.userAgent || null, metadata.ipAddress || null]
  );
  const sessionId = session.rows[0].id;
  const token = jwt.sign(
    { sub: user.id, sid: sessionId, role: user.role, telegramId: user.telegram_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return { token, user };
}

async function getCurrentUser(userId) {
  const result = await query(
    `SELECT id, telegram_username, telegram_name, account_type, role, status, is_verified, created_at
     FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function logoutSession(sessionId) {
  await query("UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

module.exports = {
  beginTelegramAuthorization,
  completeTelegramAuthorization,
  getCurrentUser,
  loginWithTelegram,
  logoutSession,
};
