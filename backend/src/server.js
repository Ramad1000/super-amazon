const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { PORT, CORS_ORIGIN, UPLOAD_DIR } = require("./config/env");
const { initializeDatabase } = require("./db/database");
const { errorHandler, notFound } = require("./middleware/error");

fs.mkdirSync(path.resolve(__dirname, "..", UPLOAD_DIR), { recursive: true });

const app = express();

app.disable("x-powered-by");
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

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
  app.listen(PORT, () => {
    console.log(`Super Amazon backend listening on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Unable to initialize the database", error);
  process.exit(1);
});
