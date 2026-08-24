const fs = require("fs");

function validationError(message) { const error = new Error(message); error.statusCode = 400; return error; }

function hasPrefix(bytes, prefix) { return prefix.every((value, index) => bytes[index] === value); }

function validateUploadedFile(file, expected) {
  if (!file?.path) throw validationError("الملف المرفوع غير صالح");
  const bytes = fs.readFileSync(file.path).subarray(0, 32);
  const isJpeg = hasPrefix(bytes, [0xff, 0xd8, 0xff]);
  const isPng = hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const isMp4 = bytes.subarray(4, 8).toString("ascii") === "ftyp";
  const isWebm = bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const image = isJpeg || isPng || isWebp;
  const video = isMp4 || isWebm || bytes.subarray(4, 8).toString("ascii") === "moov";
  if ((expected === "image" && !image) || (expected === "video" && !video) || (expected === "media" && !image && !video)) {
    throw validationError("محتوى الملف لا يطابق نوعه المسموح. ارفع صورة أو فيديو أصليًا.");
  }
}

module.exports = { validateUploadedFile };
