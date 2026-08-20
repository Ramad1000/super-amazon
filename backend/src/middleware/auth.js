const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/env");
const { query } = require("../db/database");

async function auth(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "تسجيل الدخول مطلوب" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sid) {
      return res.status(401).json({ success: false, message: "الجلسة غير صالحة" });
    }

    const session = await query(
      `SELECT s.id, u.id AS user_id, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL`,
      [payload.sid, payload.sub]
    );
    if (!session.rows.length || session.rows[0].status === "SUSPENDED") {
      return res.status(401).json({ success: false, message: "الجلسة غير صالحة أو تم إيقاف الحساب" });
    }

    await query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [payload.sid]);
    req.user = { sub: payload.sub, sid: payload.sid, role: session.rows[0].role };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "الجلسة غير صالحة أو منتهية" });
  }
}

function requireRoles(...roles) {
  return (req, res, next) => (
    roles.includes(req.user?.role)
      ? next()
      : res.status(403).json({ success: false, message: "غير مسموح لك بهذا الإجراء" })
  );
}

module.exports = { auth, requireRoles };
