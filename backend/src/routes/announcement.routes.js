const express = require("express");
const { query } = require("../db/database");
const { auth, requireRoles } = require("../middleware/auth");
const { notifyAudience } = require("../services/notification.service");

const router = express.Router();
router.use(auth);

router.get("/", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, category, title, body, audience, important, published, created_at, updated_at
       FROM announcements WHERE published = true AND (audience = 'ALL' OR audience = $1)
       ORDER BY important DESC, created_at DESC`,
      [req.user.accountType]
    );
    return res.json({ success: true, announcements: result.rows });
  } catch (error) { return next(error); }
});

router.use("/manage", requireRoles("OWNER", "OWNER_ASSISTANT"));

async function requireAnnouncementPermission(req, res, next) {
  if (req.user.role === "OWNER") return next();
  try {
    const allowed = await query("SELECT 1 FROM assistant_permissions WHERE assistant_id = $1 AND permission = 'ANNOUNCEMENTS'", [req.user.sub]);
    if (!allowed.rows.length) return res.status(403).json({ success: false, message: "ليس لديك صلاحية إدارة القوانين والتوجيهات" });
    return next();
  } catch (error) { return next(error); }
}

router.get("/manage", requireAnnouncementPermission, async (req, res, next) => {
  try {
    const result = await query("SELECT * FROM announcements ORDER BY created_at DESC");
    return res.json({ success: true, announcements: result.rows });
  } catch (error) { return next(error); }
});

router.post("/manage", requireAnnouncementPermission, async (req, res, next) => {
  const category = String(req.body?.category || "GENERAL").slice(0, 30);
  const title = String(req.body?.title || "").trim();
  const body = String(req.body?.body || "").trim();
  const audience = ["ALL", "MEMBER", "ADMIN", "BROKER"].includes(String(req.body?.audience)) ? String(req.body.audience) : "ALL";
  if (!title || !body || title.length > 250 || body.length > 10000) {
    return res.status(400).json({ success: false, message: "عنوان أو محتوى الإعلان غير صالح" });
  }
  try {
    const result = await query(
      `INSERT INTO announcements (category, title, body, audience, important, published, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [category, title, body, audience, Boolean(req.body?.important), Boolean(req.body?.published), req.user.sub]
    );
    if (result.rows[0].published) await notifyAudience(audience, title, body);
    return res.status(201).json({ success: true, announcement: result.rows[0] });
  } catch (error) { return next(error); }
});

router.patch("/manage/:id", requireAnnouncementPermission, async (req, res, next) => {
  try {
    const result = await query(
      "UPDATE announcements SET published = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [Boolean(req.body?.published), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "الإعلان غير موجود" });
    if (result.rows[0].published) await notifyAudience(result.rows[0].audience, result.rows[0].title, result.rows[0].body);
    return res.json({ success: true, announcement: result.rows[0] });
  } catch (error) { return next(error); }
});

module.exports = router;
