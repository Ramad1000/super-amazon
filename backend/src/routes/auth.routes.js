const express = require("express");
const { auth } = require("../middleware/auth");
const {
  beginTelegramAuthorization,
  completeTelegramAuthorization,
  getCurrentUser,
  loginWithTelegram,
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

module.exports = router;
