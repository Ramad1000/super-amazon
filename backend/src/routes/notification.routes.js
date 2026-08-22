const express = require("express");
const { query } = require("../db/database");
const { auth } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

router.get("/", async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
      [req.user.sub]
    );
    return res.json({ success: true, notifications: result.rows });
  } catch (error) { return next(error); }
});

router.patch("/:id/read", async (req, res, next) => {
  try {
    const result = await query(
      "UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING id, is_read",
      [req.params.id, req.user.sub]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: "الإشعار غير موجود" });
    return res.json({ success: true, notification: result.rows[0] });
  } catch (error) { return next(error); }
});

router.patch("/read-all", async (req, res, next) => {
  try {
    await query("UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false", [req.user.sub]);
    return res.json({ success: true });
  } catch (error) { return next(error); }
});

module.exports = router;
