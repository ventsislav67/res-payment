"use strict";

const path = require("path");
const dotenv = require("dotenv");
const express = require("express");

dotenv.config();

const paymentApi = require("./functions/index.js").app;

const app = express();
const PORT = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "src");
const waiterDashboardDir = path.join(publicDir, "WaiterDashboard");
const paymentCsp = [
  "default-src 'self'",
  "script-src 'self' https://www.gstatic.com https://js.stripe.com 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.googleapis.com https://api.stripe.com",
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
  "form-action 'self' https://checkout.stripe.com"
].join("; ");

const paymentRouteFiles = new Map([
  ["/payment.html", "payment.html"],
  ["/payment-success.html", "payment-success.html"],
  ["/payment-cancel.html", "payment-cancel.html"],
  ["/payment.js", "payment.js"],
  ["/payment-result.js", "payment-result.js"],
  ["/config.js", "config.js"],
  ["/style.css", "style.css"]
]);

function sendWaiterPaymentFile(res, fileName) {
  res.setHeader("Content-Security-Policy", paymentCsp);
  res.sendFile(path.join(waiterDashboardDir, fileName));
}

app.use((req, res, next) => {
  if (paymentRouteFiles.has(req.path) || req.path.startsWith("/WaiterDashboard/payment")) {
    res.setHeader("Content-Security-Policy", paymentCsp);
  }
  next();
});

// Mount API before static/fallback routes so frontend routing never captures /api.
app.use("/api", paymentApi);

app.use(express.json());
app.use("/src", express.static(publicDir));

app.get("/payment.html", (req, res) => {
  sendWaiterPaymentFile(res, "payment.html");
});

app.get("/payment-success.html", (req, res) => {
  sendWaiterPaymentFile(res, "payment-success.html");
});

app.get("/payment-cancel.html", (req, res) => {
  sendWaiterPaymentFile(res, "payment-cancel.html");
});

app.get("/payment.js", (req, res) => {
  sendWaiterPaymentFile(res, "payment.js");
});

app.get("/payment-result.js", (req, res) => {
  sendWaiterPaymentFile(res, "payment-result.js");
});

app.get("/config.js", (req, res) => {
  sendWaiterPaymentFile(res, "config.js");
});

app.get("/style.css", (req, res) => {
  sendWaiterPaymentFile(res, "style.css");
});

app.use(express.static(publicDir));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({
      error: "Payment API route not found.",
      method: req.method,
      path: req.originalUrl
    });
    return;
  }
  res.status(404).send("Not found");
});

app.listen(PORT, () => {
  console.log(`Restaurant app + Payment API running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
