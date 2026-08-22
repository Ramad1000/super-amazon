const fs = require("fs");
const path = require("path");
const multer = require("multer");

const logPath = path.resolve(__dirname, "../../logs/errors.log");

function removeUploadedFiles(files) {
  if (!files) return;

  for (const entries of Object.values(files)) {
    for (const file of entries) {
      fs.unlink(file.path, () => {});
    }
  }
}

function notFound(req, res) {
  res.status(404).json({
    success: false,
    message: "المسار المطلوب غير موجود",
  });
}

function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  removeUploadedFiles(req.files);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({
    at: new Date().toISOString(),
    message: error.message,
    name: error.name,
    path: req.originalUrl,
    method: req.method,
  })}\n`);
  console.error({
    message: error.message,
    name: error.name,
    path: req.originalUrl,
    method: req.method,
  });

  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "حجم أحد الملفات أكبر من الحد المسموح"
        : "تعذر رفع الملف";

    return res.status(400).json({ success: false, message });
  }

  const status = Number.isInteger(error.statusCode)
    ? error.statusCode
    : 500;

  const message =
    error.publicMessage ||
    (status >= 500
      ? "حدث خطأ أثناء معالجة الطلب"
      : error.message || "تعذر معالجة الطلب");

  return res.status(status).json({ success: false, message });
}

module.exports = { errorHandler, notFound };
