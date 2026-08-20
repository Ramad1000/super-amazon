const fs = require("fs");
const crypto = require("crypto");
const { pool, query } = require("../db/database");

const REQUIRED = [
  "ID_FRONT",
  "ID_BACK",
  "FACE_PHOTO",
  "IDENTITY_VIDEO"
];

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function createRequest({
  userId,
  accountType,
  fullName,
  fatherPhone,
  nationalId,
  latitude,
  longitude,
  locationAccuracy,
  files
}) {
  if (!fullName?.trim()) {
    throw validationError("الاسم الكامل مطلوب");
  }

  if (!fatherPhone?.trim()) {
    throw validationError("رقم الهاتف مطلوب");
  }

  if (!nationalId?.trim()) {
    throw validationError("رقم المستمسك مطلوب");
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw validationError("يجب تحديد موقع جغرافي صالح");
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw validationError("إحداثيات الموقع غير صالحة");
  }

  const c = await pool.connect();
  const saved = [];

  try {
    await c.query("BEGIN");

    // التحقق من المستخدم
    const userResult = await c.query(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );

    if (!userResult.rows.length) {
      throw validationError("المستخدم غير موجود");
    }

    // التأكد من نوع الطلب
    if (!["ADMIN", "BROKER"].includes(accountType)) {
      throw validationError("نوع الطلب يجب أن يكون ADMIN أو BROKER");
    }

    // التأكد من وجود الملفات الأربعة
    for (const type of REQUIRED) {
      if (!files[type]) {
        throw validationError("ملف مطلوب غير موجود: " + type);
      }
    }

    // التأكد من عدم وجود طلب نشط سابق
    const activeRequest = await c.query(
      `
      SELECT id
      FROM requests
      WHERE user_id = $1
        AND status IN ('PENDING', 'NEEDS_CORRECTION')
      LIMIT 1
      `,
      [userId]
    );

    if (activeRequest.rows.length) {
      throw validationError("لديك طلب قيد المراجعة بالفعل");
    }

    // إنشاء الطلب
    const requestResult = await c.query(
      `
      INSERT INTO requests (
        user_id,
        applicant_type,
        full_name,
        father_phone,
        national_id,
        latitude,
        longitude,
        location_accuracy,
        status
      )
      VALUES (
        $1,
        $2::account_type,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        'PENDING'::request_status
      )
      RETURNING *
      `,
      [
        userId,
        accountType,
        fullName,
        fatherPhone,
        nationalId,
        latitude,
        longitude,
        locationAccuracy || null
      ]
    );

    const request = requestResult.rows[0];

    // حفظ الملفات
    for (const type of REQUIRED) {
      const file = files[type];

      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(file.path))
        .digest("hex");

      await c.query(
        `
        INSERT INTO request_files (
          request_id,
          file_type,
          original_name,
          stored_name,
          mime_type,
          file_size,
          storage_path,
          sha256_hash
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
        `,
        [
          request.id,
          type,
          file.originalname,
          file.filename,
          file.mimetype,
          file.size,
          file.path,
          hash
        ]
      );

      saved.push(file.path);
    }

    // تغيير حالة المستخدم إلى PENDING
    await c.query(
      `
      UPDATE users
      SET
        account_type = $1::account_type,
        status = 'PENDING'::user_status,
        is_verified = false,
        updated_at = NOW()
      WHERE id = $2
      `,
      [accountType, userId]
    );

    // إشعار المستخدم
    await c.query(
      `
      INSERT INTO notifications (
        user_id,
        title,
        body
      )
      VALUES (
        $1,
        $2,
        $3
      )
      `,
      [
        userId,
        "تم استلام طلبك",
        `تم استلام طلب التقديم الخاص بك كـ ${accountType}. الطلب الآن قيد المراجعة من الإدارة.`
      ]
    );

    // تسجيل العملية
    await c.query(
      `
      INSERT INTO audit_logs (
        actor_user_id,
        action,
        target_type,
        target_id,
        details
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb
      )
      `,
      [
        userId,
        "SUBMIT_APPLICATION",
        "REQUEST",
        request.id,
        JSON.stringify({
          accountType,
          requestNumber: request.request_number,
          files: REQUIRED,
          locationProvided: true
        })
      ]
    );

    await c.query("COMMIT");

    return request;

  } catch (error) {
    await c.query("ROLLBACK");

    // حذف الملفات إذا فشلت العملية
    saved.forEach((filePath) => {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    });

    throw error;

  } finally {
    c.release();
  }
}

async function getMyRequest(userId) {
  const result = await query(
    `
    SELECT
      r.*,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', f.id,
              'type', f.file_type,
              'originalName', f.original_name,
              'mimeType', f.mime_type,
              'size', f.file_size
            )
          )
          FROM request_files f
          WHERE f.request_id = r.id
        ),
        '[]'::json
      ) AS files
    FROM requests r
    WHERE r.user_id = $1
    ORDER BY r.created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

module.exports = {
  createRequest,
  getMyRequest
};
