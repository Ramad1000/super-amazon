const express = require("express");
const { pool } = require("../db/database");
const { auth } = require("../middleware/auth");
const { OWNER_SETUP_KEY } = require("../config/env");
const {
  beginTelegramAuthorization,
  completeTelegramAuthorization,
  getCurrentUser,
  loginWithTelegram,
  loginWithTelegramWebApp,
  logoutSession,
} = require("../services/auth.service");

const router = express.Router();

router.get("/telegram/start", (req, res, next) => {
  try {
    return res.redirect(302, beginTelegramAuthorization(req.query.returnUrl));
  } catch (error) {
    return next(error);
  }
});

router.get("/telegram/callback", async (req, res, next) => {
  try {
    const result = await completeTelegramAuthorization({
      code: req.query.code,
      state: req.query.state,
      metadata: { userAgent: req.get("user-agent"), ipAddress: req.ip },
    });
    const destination = new URL(result.returnUrl);
    destination.hash = new URLSearchParams({ telegram_token: result.token }).toString();
    return res.redirect(302, destination.toString());
  } catch (error) {
    return next(error);
  }
});

router.post("/telegram/exchange", async (req, res, next) => {
  try {
    const result = await completeTelegramAuthorization({
      code: req.body?.code,
      state: req.body?.state,
      metadata: { userAgent: req.get("user-agent"), ipAddress: req.ip },
    });
    return res.json({ success: true, token: result.token, user: result.user });
  } catch (error) {
    return next(error);
  }
});

// The legacy Login Widget can redirect to this endpoint with its signed user
// data. A redirect avoids relying on popup callbacks, which mobile browsers
// often suppress.
router.get("/telegram/widget-callback", async (req, res, next) => {
  try {
    const result = await loginWithTelegram(req.query, {
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });
    return res.redirect(302, `/#telegram_token=${encodeURIComponent(result.token)}`);
  } catch (error) {
    // Keep the user on the application instead of displaying an Express error
    // page. The global handler records a minimal diagnostic entry.
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status >= 500) {
      return next(error);
    }
    return res.redirect(302, `/#telegram_error=${encodeURIComponent(error.message)}`);
  }
});

router.post("/telegram", async (req, res, next) => {
  try {
    const result = await loginWithTelegram(req.body, {
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

router.post("/telegram/webapp", async (req, res, next) => {
  try {
    const result = await loginWithTelegramWebApp(req.body?.initData, {
      userAgent: req.get("user-agent"),
      ipAddress: req.ip,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", auth, async (req, res, next) => {
  try {
    const user = await getCurrentUser(req.user.sub);
    if (!user) {
      return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    }
    return res.json({ success: true, user });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", auth, async (req, res, next) => {
  try {
    await logoutSession(req.user.sid);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/claim-owner", auth, async (req, res, next) => {
  if (!OWNER_SETUP_KEY) {
    return res.status(503).json({ success: false, message: "لم يتم إعداد رمز Owner في الخادم" });
  }
  if (String(req.body?.setupKey || "") !== OWNER_SETUP_KEY) {
    return res.status(403).json({ success: false, message: "رمز Owner غير صحيح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM users WHERE role = 'OWNER'::user_role FOR UPDATE");
    if (existing.rows.length && existing.rows[0].id !== req.user.sub) {
      await client.query("ROLLBACK");
      return res.status(409).json({ success: false, message: "تم ربط حساب Owner بالفعل" });
    }
    const result = await client.query(
      `UPDATE users SET role = 'OWNER'::user_role, account_type = 'ADMIN'::account_type,
       status = 'ACTIVE'::user_status, is_verified = true, updated_at = NOW()
       WHERE id = $1 RETURNING id, telegram_name, role, account_type`,
      [req.user.sub]
    );
    await client.query("COMMIT");
    return res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
