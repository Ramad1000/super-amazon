const crypto = require("crypto");

// Small dependency-free limiter. Render can run more than one instance, so it
// is intentionally a first line of defence; a CDN/WAF can be added later for
// global distributed rate limiting.
function rateLimit({ windowMs, max, key = (req) => req.ip } = {}) {
  const visits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = String(key(req) || "anonymous");
    const item = visits.get(id);
    if (!item || item.resetAt <= now) {
      visits.set(id, { count: 1, resetAt: now + windowMs });
      return next();
    }
    item.count += 1;
    if (item.count > max) {
      res.setHeader("Retry-After", Math.ceil((item.resetAt - now) / 1000));
      return res.status(429).json({ success: false, message: "تم إرسال طلبات كثيرة. انتظر قليلًا ثم أعد المحاولة." });
    }
    return next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), payment=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Request-Id", crypto.randomUUID());
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return next();
}

module.exports = { rateLimit, securityHeaders };
