"use strict";

const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");
const admin = require("firebase-admin");
const Stripe = require("stripe");

dotenv.config();

const SERVICE_NAME = "restaurant-payment-backend";
const CURRENCY = "EUR";
const STRIPE_CURRENCY = "eur";
const STRIPE_API_VERSION = "2026-02-25.clover";

function initFirebaseAdmin() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  return admin.firestore();
}

const FieldValue = admin.firestore.FieldValue;
let firestoreDb = null;
const stripeClient = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

const app = express();

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      process.env.FRONTEND_ORIGIN,
      "https://reustarant-software.web.app",
      "https://reustarant-software.firebaseapp.com",
      "http://localhost:5500",
      "http://127.0.0.1:5500"
    ].filter(Boolean);

    const isAllowed =
      allowedOrigins.includes(origin) ||
      /^https:\/\/[a-z0-9-]+\.ngrok-free\.dev$/i.test(origin);

    if (isAllowed) return callback(null, true);

    return callback(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendError(res, err) {
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    error: err.message || "Payment backend error."
  });
}

function asyncRoute(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => sendError(res, err));
  };
}

function protectedRoute(handler) {
  return asyncRoute(async (req, res) => {
    const user = await requireFirebaseUser(req);
    await handler(req, res, user);
  });
}

function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getDb() {
  if (!firestoreDb) {
    firestoreDb = initFirebaseAdmin();
  }
  return firestoreDb;
}

function roundMoney(value) {
  return Math.round((safeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function toCents(value) {
  return Math.round(roundMoney(value) * 100);
}

function readQty(value) {
  const raw = value && typeof value === "object"
    ? value.qty ?? value.quantity ?? value.count ?? value.amountQty
    : value;
  return Math.max(0, safeNumber(raw, 0));
}

function readLineTotal(item) {
  if (!item || typeof item !== "object") return 0;

  const qty = readQty(item);
  const unitPrice = safeNumber(
    item.price ?? item.unitPrice ?? item.unit_price ?? item.priceEur ?? item.priceEUR,
    0
  );
  const calculated = qty * unitPrice;
  if (calculated > 0) return roundMoney(calculated);

  const storedLineTotal = safeNumber(
    item.lineTotal ?? item.total ?? item.totalPrice ?? item.amount,
    0
  );
  return roundMoney(Math.max(0, storedLineTotal));
}

async function loadOrder(orderId) {
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) {
    throw httpError(400, "Missing orderId.");
  }

  const ref = getDb().collection("orders").doc(cleanOrderId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw httpError(404, "Order not found.");
  }

  const data = snap.data() || {};
  let items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) {
    const itemsSnap = await ref.collection("items").get();
    items = itemsSnap.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() || {})
    }));
  }

  const amount = roundMoney(items.reduce((sum, item) => sum + readLineTotal(item), 0));

  return {
    ref,
    id: cleanOrderId,
    data,
    items,
    amount
  };
}

async function createPaymentDoc(payload) {
  const ref = getDb().collection("payments").doc();
  const now = FieldValue.serverTimestamp();
  await ref.set({
    ...payload,
    createdAt: now,
    updatedAt: now
  });
  return {
    ref,
    id: ref.id
  };
}

function getStripe() {
  return stripeClient;
}

function requireStripe() {
  const stripe = getStripe();
  if (!stripe) {
    throw httpError(501, "Stripe is not configured. Missing STRIPE_SECRET_KEY.");
  }
  return stripe;
}

async function requireFirebaseUser(req) {
  const authHeader = String(req.headers.authorization || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw httpError(401, "Missing Authorization bearer token.");
  }
  getDb();
  return admin.auth().verifyIdToken(match[1]);
}

function serializeFirestoreValue(value) {
  if (!value) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeFirestoreValue(item)])
    );
  }
  return value;
}

function publicPaymentData(snap) {
  if (!snap?.exists) return null;
  return {
    id: snap.id,
    ...serializeFirestoreValue(snap.data() || {})
  };
}

function appendQueryParams(url, params) {
  if (!url) throw httpError(400, "Missing return URL.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw httpError(400, "Invalid return URL.");
  }

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      parsed.searchParams.set(key, String(value));
    }
  });

  return parsed.toString();
}

function appendRawQueryParam(url, key, value) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${value}`;
}

function buildSuccessUrl(baseUrl, { provider, paymentId, orderId }) {
  return appendRawQueryParam(
    appendQueryParams(baseUrl, { provider, paymentId, orderId }),
    "session_id",
    "{CHECKOUT_SESSION_ID}"
  );
}

function buildCancelUrl(baseUrl, { provider, paymentId, orderId }) {
  return appendQueryParams(baseUrl, { provider, paymentId, orderId });
}

async function findPaymentByStripeSessionId(sessionId) {
  const snap = await getDb().collection("payments")
    .where("stripeSessionId", "==", sessionId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

async function findLatestPaymentForOrder(orderId) {
  const snap = await getDb().collection("payments")
    .where("orderId", "==", orderId)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

async function resolvePaymentSnap({ paymentId, sessionId, orderId }) {
  if (paymentId) {
    const snap = await getDb().collection("payments").doc(paymentId).get();
    return snap.exists ? snap : null;
  }

  if (sessionId) {
    return findPaymentByStripeSessionId(sessionId);
  }

  if (orderId) {
    return findLatestPaymentForOrder(orderId);
  }

  throw httpError(400, "Missing paymentId, sessionId or orderId.");
}

function normalizeCheckoutStatus(session, currentStatus) {
  if (currentStatus === "paid") return "paid";
  if (session.payment_status === "paid") return "paid";
  if (session.status === "expired" || session.status === "canceled") return "cancelled";
  return currentStatus || "pending";
}

async function handleCreateStripeCheckoutSession(req, res, options = {}) {
  const stripe = requireStripe();
  const body = req.body || {};
  const orderId = String(body.orderId || "").trim();
  const setup = await loadOrder(orderId);
  const tableId = String(body.tableId || setup.data.tableId || "").trim();
  const tipAmount = roundMoney(Math.max(0, safeNumber(body.tipAmount, 0)));
  const totalAmount = roundMoney(setup.amount + tipAmount);

  if (totalAmount <= 0) {
    throw httpError(400, "Payment total must be greater than zero.");
  }

  const paymentRef = getDb().collection("payments").doc();
  const paymentId = paymentRef.id;

  const successUrl = buildSuccessUrl(body.successUrl, {
    provider: "stripe",
    paymentId,
    orderId: setup.id
  });
  const cancelUrl = buildCancelUrl(body.cancelUrl, {
    provider: "stripe",
    paymentId,
    orderId: setup.id
  });

  const metadata = {
    paymentId,
    orderId: setup.id,
    tableId,
    source: options.source || "qr_client_demo"
  };

  const now = FieldValue.serverTimestamp();
  await paymentRef.set({
    provider: "stripe",
    method: "card",
    status: "pending",
    paymentStatus: "pending",
    orderId: setup.id,
    tableId,
    amount: setup.amount,
    tipAmount,
    totalAmount,
    currency: CURRENCY,
    source: options.source || "qr_client_demo",
    staffUid: options.user?.uid || null,
    createdAt: now,
    updatedAt: now
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: STRIPE_CURRENCY,
          product_data: {
            name: `Restaurant order ${setup.id}`
          },
          unit_amount: toCents(totalAmount)
        },
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    payment_intent_data: {
      metadata
    }
  });

  await paymentRef.set({
    stripeSessionId: session.id,
    checkoutUrl: session.url || "",
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  res.json({
    checkoutUrl: session.url,
    paymentId,
    sessionId: session.id
  });
}

async function markStripePaymentPaid({ paymentSnap, session }) {
  const paymentId = paymentSnap.id;
  const paymentRef = paymentSnap.ref;
  const payment = paymentSnap.data() || {};
  const orderId = payment.orderId || session.metadata?.orderId || "";
  const tableId = payment.tableId || session.metadata?.tableId || "";
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id || "";
  const now = FieldValue.serverTimestamp();

  await paymentRef.set({
    status: "paid",
    paymentStatus: "paid",
    stripePaymentIntentId: paymentIntentId,
    paidAt: now,
    updatedAt: now
  }, { merge: true });

  if (orderId) {
    await getDb().collection("orders").doc(orderId).set({
      status: "paid",
      paymentStatus: "paid",
      paidAt: now,
      updatedAt: now
    }, { merge: true });
  }

  if (tableId) {
    await getDb().collection("tables").doc(tableId).set({
      status: "free",
      activeOrders: [],
      currentOrderId: "",
      updatedAt: now
    }, { merge: true });
  }

  return paymentRef.get();
}

async function handleCheckPayment(req, res) {
  const body = req.body || {};
  const requestedPaymentId = String(body.paymentId || "").trim();
  const requestedSessionId = String(body.sessionId || body.session_id || "").trim();
  const requestedOrderId = String(body.orderId || "").trim();
  let paymentSnap = await resolvePaymentSnap({
    paymentId: requestedPaymentId,
    sessionId: requestedSessionId,
    orderId: requestedOrderId
  });

  if (!paymentSnap?.exists) {
    throw httpError(404, "Payment not found.");
  }

  const payment = paymentSnap.data() || {};
  let status = payment.status || payment.paymentStatus || "pending";
  let paymentStatus = payment.paymentStatus || payment.status || "pending";

  if (payment.provider === "stripe" && payment.stripeSessionId) {
    const stripe = requireStripe();
    const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
    status = normalizeCheckoutStatus(session, status);
    paymentStatus = status;

    if (session.payment_status === "paid") {
      paymentSnap = await markStripePaymentPaid({ paymentSnap, session });
      status = "paid";
      paymentStatus = "paid";
    } else {
      await paymentSnap.ref.set({
        status,
        paymentStatus,
        stripeCheckoutStatus: session.status || "",
        stripePaymentStatus: session.payment_status || "",
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      paymentSnap = await paymentSnap.ref.get();
    }
  }

  const nextPayment = publicPaymentData(paymentSnap);

  res.json({
    paymentId: paymentSnap.id,
    status,
    paymentStatus,
    provider: nextPayment?.provider || payment.provider || null,
    totalAmount: safeNumber(nextPayment?.totalAmount ?? payment.totalAmount, 0),
    currency: nextPayment?.currency || payment.currency || CURRENCY,
    payment: nextPayment
  });
}

async function handleCreateBankTransfer(req, res, user) {
  const body = req.body || {};
  const setup = await loadOrder(body.orderId);
  const tableId = String(body.tableId || setup.data.tableId || "").trim();
  const tipAmount = roundMoney(Math.max(0, safeNumber(body.tipAmount, 0)));
  const totalAmount = roundMoney(setup.amount + tipAmount);

  if (totalAmount <= 0) {
    throw httpError(400, "Payment total must be greater than zero.");
  }

  const paymentDoc = await createPaymentDoc({
    provider: "bank_transfer",
    method: "bank_transfer",
    status: "pending",
    paymentStatus: "pending",
    orderId: setup.id,
    tableId,
    amount: setup.amount,
    tipAmount,
    totalAmount,
    currency: CURRENCY,
    source: "staff_backend",
    staffUid: user.uid
  });

  const reference = `DEMO-${paymentDoc.id.slice(0, 8).toUpperCase()}`;
  await paymentDoc.ref.set({
    bankTransferReference: reference,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  res.json({
    paymentId: paymentDoc.id,
    provider: "bank_transfer",
    method: "bank_transfer",
    status: "pending",
    paymentStatus: "pending",
    amount: setup.amount,
    tipAmount,
    totalAmount,
    currency: CURRENCY,
    bankTransferReference: reference,
    bankTransferInstructions: {
      reference,
      iban: process.env.BANK_IBAN || "",
      beneficiary: process.env.BANK_BENEFICIARY || "",
      amount: totalAmount,
      currency: CURRENCY
    }
  });
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: SERVICE_NAME });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: SERVICE_NAME });
});

app.post("/api/public/payments/stripe/create-checkout-session", asyncRoute((req, res) => {
  return handleCreateStripeCheckoutSession(req, res, { source: "qr_client_demo" });
}));

app.post("/api/public/payments/stripe/checkout-session", asyncRoute((req, res) => {
  return handleCreateStripeCheckoutSession(req, res, { source: "qr_client_demo" });
}));

app.post("/api/public/payments/check", asyncRoute(handleCheckPayment));

app.post("/api/payments/stripe/create-checkout-session", protectedRoute((req, res, user) => {
  return handleCreateStripeCheckoutSession(req, res, {
    source: "staff_backend",
    user
  });
}));

app.post("/api/payments/check", protectedRoute((req, res) => {
  return handleCheckPayment(req, res);
}));

app.post("/api/payments/bank-transfer/create", protectedRoute(handleCreateBankTransfer));

app.post("/api/payments/revolut/create-order", protectedRoute(async (req, res) => {
  res.status(501).json({
    error: "Revolut is not configured in this payment backend."
  });
}));

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found.",
    method: req.method,
    path: req.originalUrl
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  sendError(res, err);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Payment backend running on port ${PORT}`);
  console.log("Health: /api/health");
});
