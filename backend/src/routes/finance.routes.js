const express = require("express");
const { query } = require("../db/database");
const { auth } = require("../middleware/auth");

const router = express.Router();
router.use(auth);

router.get("/me", async (req, res, next) => {
  try {
    const totals = await query(
      `SELECT COALESCE(SUM(total_amount),0) AS total, COALESCE(SUM(paid_amount),0) AS paid
       FROM broker_lifts WHERE broker_id = $1`, [req.user.sub]
    );
    const payments = await query(
      `SELECT p.*, l.total_amount AS lift_total FROM broker_payments p
       LEFT JOIN broker_lifts l ON l.id = p.lift_id WHERE p.broker_id = $1
       ORDER BY p.payment_date DESC LIMIT 100`, [req.user.sub]
    );
    const total = Number(totals.rows[0].total);
    const paid = Number(totals.rows[0].paid);
    return res.json({ success: true, summary: { total, paid, remaining: total - paid }, payments: payments.rows });
  } catch (error) { return next(error); }
});

module.exports = router;
