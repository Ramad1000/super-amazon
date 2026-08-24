const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const path = require("path");
const { auth } = require("../middleware/auth");
const { createRequest, correctRequest, getMyRequest } = require("../services/request.service");
const { validateUploadedFile } = require("../services/file-validation.service");

const router = express.Router();
const directory = path.resolve(__dirname, "../../uploads");
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const videoTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);

const storage = multer.diskStorage({
  destination: (req, file, callback) => callback(null, directory),
  filename: (req, file, callback) => {
    callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 4 },
  fileFilter: (req, file, callback) => {
    const allowed = file.fieldname === "identityVideo"
      ? videoTypes.has(file.mimetype)
      : imageTypes.has(file.mimetype);

    if (!allowed) {
      const error = new Error("نوع الملف غير مسموح");
      error.statusCode = 400;
      return callback(error);
    }

    return callback(null, true);
  },
});

const fields = upload.fields([
  { name: "idFront", maxCount: 1 },
  { name: "idBack", maxCount: 1 },
  { name: "facePhoto", maxCount: 1 },
  { name: "identityVideo", maxCount: 1 },
]);

const one = (files, name) => files?.[name]?.[0] || null;

router.post("/", auth, fields, async (req, res, next) => {
  try {
    for (const [name, values] of Object.entries(req.files || {})) validateUploadedFile(values[0], name === "identityVideo" ? "video" : "image");
    const body = req.body;
    const request = await createRequest({
      userId: req.user.sub,
      accountType: body.accountType,
      fullName: body.fullName,
      fatherPhone: body.fatherPhone,
      nationalId: body.nationalId,
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      locationAccuracy: body.locationAccuracy,
      privacyAccepted: body.privacyAccepted === "true",
      files: {
        ID_FRONT: one(req.files, "idFront"),
        ID_BACK: one(req.files, "idBack"),
        FACE_PHOTO: one(req.files, "facePhoto"),
        IDENTITY_VIDEO: one(req.files, "identityVideo"),
      },
    });

    res.status(201).json({ success: true, request });
  } catch (error) {
    next(error);
  }
});

router.patch("/:id/correct", auth, fields, async (req, res, next) => {
  try {
    for (const [name, values] of Object.entries(req.files || {})) validateUploadedFile(values[0], name === "identityVideo" ? "video" : "image");
    const body = req.body;
    const request = await correctRequest({
      userId: req.user.sub,
      requestId: req.params.id,
      accountType: body.accountType,
      fullName: body.fullName,
      fatherPhone: body.fatherPhone,
      nationalId: body.nationalId,
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      locationAccuracy: body.locationAccuracy,
      files: {
        ID_FRONT: one(req.files, "idFront"),
        ID_BACK: one(req.files, "idBack"),
        FACE_PHOTO: one(req.files, "facePhoto"),
        IDENTITY_VIDEO: one(req.files, "identityVideo"),
      },
    });
    return res.json({ success: true, request });
  } catch (error) {
    return next(error);
  }
});

router.get("/me", auth, async (req, res, next) => {
  try {
    const request = await getMyRequest(req.user.sub);
    res.json({ success: true, request });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
