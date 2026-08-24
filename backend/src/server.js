const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { PORT, CORS_ORIGIN, UPLOAD_DIR } = require("./config/env");
const { initializeDatabase } = require("./db/database");
const { startBackupScheduler } = require("./services/backup.service");
const { errorHandler, notFound } = require("./middleware/error");
const { rateLimit, securityHeaders } = require("./middleware/security");

fs.mkdirSync(path.resolve(__dirname, "..", UPLOAD_DIR), { recursive: true });

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(securityHeaders);
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));
app.use("/api", rateLimit({ windowMs: 60 * 1000, max: 180 }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 30 }));

app.get("/health", (req, res) => {
  res.json({ success: true, service: "super-amazon-backend" });
});

app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/requests", require("./routes/request.routes"));
app.use("/api/owner", require("./routes/owner.routes"));
app.use("/api/complaints", require("./routes/complaint.routes"));
app.use("/api/notifications", require("./routes/notification.routes"));
app.use("/api/announcements", require("./routes/announcement.routes"));
app.use("/api/finance", require("./routes/finance.routes"));

// In production Render serves the compiled React application from this same
// Node service, so the browser can call /api without a separate tunnel.
const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^(?!\/api(?:\/|$)).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.use(notFound);
app.use(errorHandler);

async function start() {
  await initializeDatabase();
  startBackupScheduler();
  app.listen(PORT, () => {
    console.log(`Super Amazon backend listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Unable to initialize the database", error);
  process.exit(1);
});
