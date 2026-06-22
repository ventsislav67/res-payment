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
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
    }
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    try {
      const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
      serviceAccount = JSON.parse(decoded);
    } catch (err) {
      throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable.");
    }
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    serviceAccount = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY
    };
  } else {
    throw new Error(
      "Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON, " +
      "FIREBASE_SERVICE_ACCOUNT_BASE64, or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
    );
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

app.post([
  "/api/payments/stripe/webhook",
  "/webhook/stripe",
  "/api/webhooks/stripe",
  "/webhooks/stripe"
], express.raw({ type: "application/json" }), handleStripeWebhook);

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
  let snap = await getDb().collection("payments")
    .where("stripeSessionId", "==", sessionId)
    .limit(1)
    .get();
  if (snap.empty) {
    snap = await getDb().collection("payments")
      .where("stripeCheckoutSessionId", "==", sessionId)
      .limit(1)
      .get();
  }
  return snap.empty ? null : snap.docs[0];
}

async function findPaymentByStripePaymentIntentId(paymentIntentId) {
  const snap = await getDb().collection("payments")
    .where("stripePaymentIntentId", "==", paymentIntentId)
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

function isPaidRecord(data) {
  const status = String(data?.status || data?.paymentStatus || "").trim().toLowerCase();
  return data?.paid === true || ["successful", "paid", "succeeded", "confirmed"].includes(status);
}

function normalizeCheckoutStatus(session, currentStatus, currentPaid = false) {
  const normalizedCurrent = String(currentStatus || "").trim().toLowerCase();
  if (currentPaid || ["successful", "paid", "succeeded", "confirmed"].includes(normalizedCurrent)) {
    return "successful";
  }
  if (session.payment_status === "paid" || session.payment_status === "no_payment_required") {
    return "successful";
  }
  if (session.status === "expired" || session.status === "canceled") return "cancelled";
  return normalizedCurrent || "pending";
}

async function handleCreateStripeCheckoutSession(req, res, options = {}) {
  const stripe = requireStripe();
  const body = req.body || {};
  const method = options.method === "revolut" ? "revolut" : "card";
  const resultProvider = method === "revolut" ? "revolut" : "stripe";
  const orderId = String(body.orderId || "").trim();
  const setup = await loadOrder(orderId);
  const tableId = String(body.tableId || setup.data.tableId || "").trim();
  const waiterId = String(
    options.user?.uid || setup.data.waiterId || setup.data.createdBy || ""
  ).trim();
  const tipAmount = roundMoney(Math.max(0, safeNumber(body.tipAmount, 0)));
  const totalAmount = roundMoney(setup.amount + tipAmount);

  if (totalAmount <= 0) {
    throw httpError(400, "Payment total must be greater than zero.");
  }

  const paymentRef = getDb().collection("payments").doc();
  const paymentId = paymentRef.id;

  const successUrl = buildSuccessUrl(body.successUrl, {
    provider: resultProvider,
    paymentId,
    orderId: setup.id
  });
  const cancelUrl = buildCancelUrl(body.cancelUrl, {
    provider: resultProvider,
    paymentId,
    orderId: setup.id
  });

  const metadata = {
    paymentId,
    orderId: setup.id,
    tableId,
    method,
    waiterId: waiterId || "public_customer",
    source: options.source || "qr_client_demo"
  };

  const now = FieldValue.serverTimestamp();
  await paymentRef.set({
    provider: "stripe",
    method,
    status: "pending",
    paymentStatus: "pending",
    paid: false,
    orderId: setup.id,
    tableId,
    waiterId: waiterId || null,
    amount: setup.amount,
    tipAmount,
    totalAmount,
    currency: CURRENCY,
    source: options.source || "qr_client_demo",
    staffUid: options.user?.uid || null,
    createdAt: now,
    updatedAt: now
  });

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: method === "revolut" ? ["revolut_pay"] : ["card"],
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
  } catch (err) {
    console.error("[payments] Stripe Checkout creation failed", {
      paymentId,
      orderId: setup.id,
      method,
      error: err.message
    });
    await paymentRef.set({
      status: "failed",
      paymentStatus: "failed",
      failureMessage: err.message || "Stripe Checkout creation failed.",
      failedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    throw err;
  }

  await paymentRef.set({
    stripeSessionId: session.id,
    stripeCheckoutSessionId: session.id,
    checkoutUrl: session.url || "",
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await setup.ref.set({
    paymentStatus: "pending",
    paymentPending: true,
    pendingPaymentId: paymentId,
    pendingPaymentMethod: method,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  console.log("[payments] Stripe Checkout session created", {
    paymentId,
    orderId: setup.id,
    tableId,
    method,
    stripeSessionId: session.id
  });

  res.json({
    checkoutUrl: session.url,
    paymentId,
    sessionId: session.id
  });
}

async function markStripePaymentSuccessful({ paymentSnap, session }) {
  const paymentId = paymentSnap.id;
  const paymentRef = paymentSnap.ref;
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id || "";
  const db = getDb();

  const result = await db.runTransaction(async (tx) => {
    const freshPaymentSnap = await tx.get(paymentRef);
    if (!freshPaymentSnap.exists) {
      throw httpError(404, "Payment not found.");
    }

    const payment = freshPaymentSnap.data() || {};
    const orderId = String(
      payment.orderId || session.metadata?.orderId || session.metadata?.order_id || ""
    ).trim();
    const method = String(payment.method || session.metadata?.method || "card").trim().toLowerCase();

    if (!orderId) {
      console.warn("[payments] Stripe confirmation is missing order metadata", {
        paymentId,
        stripeSessionId: session.id || "",
        stripePaymentIntentId: paymentIntentId
      });
      throw httpError(400, "Stripe payment is missing orderId metadata.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await tx.get(orderRef);

    if (!orderSnap.exists) {
      throw httpError(404, "Order not found.");
    }

    const order = orderSnap.data() || {};
    const tableId = String(
      payment.tableId || session.metadata?.tableId || session.metadata?.table_id || order.tableId || ""
    ).trim();
    const tableRef = tableId ? db.collection("tables").doc(tableId) : null;
    const tableSnap = tableRef ? await tx.get(tableRef) : null;
    const table = tableSnap?.exists ? (tableSnap.data() || {}) : {};
    const activeOrderIds = [];
    const addActiveOrder = (value) => {
      const id = String(value || "").trim();
      if (id && id !== orderId && !activeOrderIds.includes(id)) activeOrderIds.push(id);
    };

    (Array.isArray(table.activeOrders) ? table.activeOrders : []).forEach(addActiveOrder);
    addActiveOrder(table.currentOrderId);
    addActiveOrder(table.activeOrderId);

    const otherOrderSnaps = await Promise.all(
      activeOrderIds.map((id) => tx.get(db.collection("orders").doc(id)))
    );
    const remainingUnpaidOrderIds = activeOrderIds.filter((id, index) => {
      const otherOrderSnap = otherOrderSnaps[index];
      return otherOrderSnap.exists && !isPaidRecord(otherOrderSnap.data() || {});
    });

    const now = FieldValue.serverTimestamp();
    const paymentReference = paymentIntentId || session.id || payment.paymentReference || "";
    const sessionTotal = Number.isFinite(Number(session.amount_total))
      ? roundMoney(Number(session.amount_total) / 100)
      : safeNumber(payment.totalAmount, 0);
    const alreadySuccessful = isPaidRecord(payment) && isPaidRecord(order);

    tx.set(paymentRef, {
      status: "successful",
      paymentStatus: "paid",
      paid: true,
      paidAt: payment.paidAt || now,
      provider: "stripe",
      method,
      totalAmount: sessionTotal,
      currency: String(session.currency || payment.currency || CURRENCY).toUpperCase(),
      stripeAmountTotal: Number.isFinite(Number(session.amount_total))
        ? Number(session.amount_total)
        : null,
      stripeSessionId: session.id || payment.stripeSessionId || "",
      stripeCheckoutSessionId: session.id || payment.stripeCheckoutSessionId || "",
      stripePaymentIntentId: paymentIntentId || payment.stripePaymentIntentId || "",
      stripeCheckoutStatus: session.status || "",
      stripePaymentStatus: session.payment_status || "",
      paymentReference,
      providerPaymentId: paymentReference,
      updatedAt: now
    }, { merge: true });

    tx.set(orderRef, {
      status: "paid",
      orderStatus: "closed",
      paymentStatus: "paid",
      paid: true,
      paidAt: order.paidAt || now,
      closedAt: order.closedAt || now,
      paymentId,
      paymentMethod: method,
      paymentProvider: "stripe",
      paymentReference,
      paymentPending: false,
      pendingPaymentId: null,
      pendingPaymentMethod: null,
      updatedAt: now
    }, { merge: true });

    if (tableRef) {
      const nextActiveOrderId = remainingUnpaidOrderIds[0] || null;
      tx.set(tableRef, {
        status: remainingUnpaidOrderIds.length ? "busy" : "free",
        activeOrders: remainingUnpaidOrderIds,
        activeOrderId: nextActiveOrderId,
        currentOrderId: nextActiveOrderId || "",
        updatedAt: now
      }, { merge: true });
    }

    return { alreadySuccessful, orderId, tableId, method, paymentReference };
  });

  console.log("[payments] Payment marked successful", {
    paymentId,
    orderId: result.orderId,
    tableId: result.tableId,
    method: result.method,
    paymentReference: result.paymentReference,
    alreadySuccessful: result.alreadySuccessful
  });

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

  if (payment.provider === "stripe" && (payment.stripeSessionId || payment.stripeCheckoutSessionId)) {
    const stripe = requireStripe();
    const session = await stripe.checkout.sessions.retrieve(
      payment.stripeSessionId || payment.stripeCheckoutSessionId,
      {
      expand: ["payment_intent"]
      }
    );
    status = normalizeCheckoutStatus(session, status, payment.paid === true);
    paymentStatus = status === "successful" ? "paid" : status;

    if (status === "successful") {
      paymentSnap = await markStripePaymentSuccessful({ paymentSnap, session });
      status = "successful";
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

async function resolveStripePaymentSnap({ metadata, sessionId, paymentIntentId }) {
  const metadataPaymentId = String(metadata?.paymentId || metadata?.payment_id || "").trim();

  if (metadataPaymentId) {
    const paymentSnap = await getDb().collection("payments").doc(metadataPaymentId).get();
    if (paymentSnap.exists) return paymentSnap;

    console.warn("[payments] Stripe metadata paymentId was not found", {
      paymentId: metadataPaymentId,
      sessionId: sessionId || "",
      paymentIntentId: paymentIntentId || ""
    });
  } else {
    console.warn("[payments] Stripe event is missing paymentId metadata", {
      sessionId: sessionId || "",
      paymentIntentId: paymentIntentId || ""
    });
  }

  if (sessionId) {
    const bySession = await findPaymentByStripeSessionId(sessionId);
    if (bySession?.exists) return bySession;
  }

  if (paymentIntentId) {
    const byIntent = await findPaymentByStripePaymentIntentId(paymentIntentId);
    if (byIntent?.exists) return byIntent;
  }

  return null;
}

async function confirmStripeCheckoutSession(session, source) {
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id || "";
  const status = normalizeCheckoutStatus(session, "pending");

  if (status !== "successful") {
    return {
      ok: false,
      status,
      paymentId: String(session.metadata?.paymentId || session.metadata?.payment_id || "").trim() || null,
      orderId: String(session.metadata?.orderId || session.metadata?.order_id || "").trim() || null,
      tableId: String(session.metadata?.tableId || session.metadata?.table_id || "").trim() || null
    };
  }

  const paymentSnap = await resolveStripePaymentSnap({
    metadata: session.metadata,
    sessionId: session.id,
    paymentIntentId
  });
  if (!paymentSnap?.exists) {
    throw httpError(404, "Stripe payment record not found.");
  }

  const updatedPaymentSnap = await markStripePaymentSuccessful({ paymentSnap, session });
  const payment = updatedPaymentSnap.data() || {};

  return {
    ok: true,
    status: "successful",
    paymentStatus: "paid",
    paymentId: updatedPaymentSnap.id,
    orderId: payment.orderId || session.metadata?.orderId || session.metadata?.order_id || null,
    tableId: payment.tableId || session.metadata?.tableId || session.metadata?.table_id || null,
    source,
    payment: publicPaymentData(updatedPaymentSnap)
  };
}

async function handleStripeWebhook(req, res) {
  const stripe = getStripe();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!stripe || !webhookSecret) {
    return res.status(500).json({ error: "Stripe webhook is not configured." });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      webhookSecret
    );
  } catch (err) {
    console.warn("[payments] Stripe webhook signature verification failed", {
      error: err.message
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("[payments] Stripe webhook received", {
    eventId: event.id,
    type: event.type
  });

  try {
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const eventSession = event.data.object;
      const session = await stripe.checkout.sessions.retrieve(eventSession.id, {
        expand: ["payment_intent"]
      });
      await confirmStripeCheckoutSession(session, `webhook:${event.type}`);
    } else if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const paymentSnap = await resolveStripePaymentSnap({
        metadata: paymentIntent.metadata,
        paymentIntentId: paymentIntent.id
      });

      if (paymentSnap?.exists) {
        const payment = paymentSnap.data() || {};
        await markStripePaymentSuccessful({
          paymentSnap,
          session: {
            id: payment.stripeSessionId || payment.stripeCheckoutSessionId || "",
            metadata: paymentIntent.metadata || {},
            payment_intent: paymentIntent,
            amount_total: paymentIntent.amount_received || paymentIntent.amount,
            payment_status: "paid",
            status: "complete"
          }
        });
      }
    } else if (event.type === "payment_intent.payment_failed") {
      const paymentIntent = event.data.object;
      const paymentSnap = await resolveStripePaymentSnap({
        metadata: paymentIntent.metadata,
        paymentIntentId: paymentIntent.id
      });

      if (paymentSnap?.exists && !isPaidRecord(paymentSnap.data() || {})) {
        await paymentSnap.ref.set({
          status: "failed",
          paymentStatus: "failed",
          paid: false,
          stripePaymentIntentId: paymentIntent.id,
          failureMessage: paymentIntent.last_payment_error?.message || "Payment failed.",
          failedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    } else if (event.type === "checkout.session.expired") {
      const session = event.data.object;
      const paymentSnap = await resolveStripePaymentSnap({
        metadata: session.metadata,
        sessionId: session.id,
        paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : ""
      });

      if (paymentSnap?.exists && !isPaidRecord(paymentSnap.data() || {})) {
        await paymentSnap.ref.set({
          status: "cancelled",
          paymentStatus: "cancelled",
          paid: false,
          stripeCheckoutStatus: session.status || "expired",
          cancelledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("[payments] Stripe webhook update failed", {
      eventId: event.id,
      type: event.type,
      error: err.message
    });
    return sendError(res, err);
  }
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
  return handleCreateStripeCheckoutSession(req, res, {
    source: "qr_client_demo",
    method: "card"
  });
}));

app.post("/api/public/payments/stripe/checkout-session", asyncRoute((req, res) => {
  return handleCreateStripeCheckoutSession(req, res, {
    source: "qr_client_demo",
    method: "card"
  });
}));

app.post("/api/public/payments/revolut/create-order", asyncRoute((req, res) => {
  return handleCreateStripeCheckoutSession(req, res, {
    source: "qr_client_demo",
    method: "revolut"
  });
}));

app.post("/api/public/payments/check", asyncRoute(handleCheckPayment));

async function handleConfirmStripeSession(req, res) {
  const sessionId = String(req.query.session_id || req.query.sessionId || "").trim();
  if (!sessionId) {
    return res.status(400).json({
      ok: false,
      error: "Missing session_id"
    });
  }

  console.log("Confirming Stripe session:", sessionId);

  try {
    const stripe = requireStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"]
    });

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: "Stripe session not found"
      });
    }

    if (session.payment_status !== "paid") {
      return res.json({
        ok: false,
        status: session.payment_status || "pending",
        message: "Stripe session is not paid yet"
      });
    }

    const metadata = session.metadata || {};
    const metadataPaymentId = String(metadata.paymentId || metadata.payment_id || "").trim();
    if (!metadataPaymentId) {
      console.warn("[payments] Confirmed Stripe session is missing paymentId metadata", {
        stripeSessionId: session.id,
        metadata
      });
      return res.status(400).json({
        ok: false,
        error: "Missing paymentId in Stripe session metadata",
        metadata
      });
    }

    const result = await confirmStripeCheckoutSession(session, "success-page-fallback");

    if (!result.ok) {
      return res.json({
        ...result,
        message: "Stripe session is not paid yet"
      });
    }

    const paymentReference = result.payment?.paymentReference || (
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id || session.id
    );

    console.log("Stripe payment confirmed:", {
      paymentId: result.paymentId,
      orderId: result.orderId,
      tableId: result.tableId
    });

    return res.json({
      ...result,
      ok: true,
      status: "successful",
      stripeSessionId: session.id,
      paymentReference
    });
  } catch (error) {
    console.error("Confirm Stripe session failed:", error);
    return res.status(error.statusCode || error.status || 500).json({
      ok: false,
      error: error.message || "Confirm session failed"
    });
  }
}

app.get("/api/payments/confirm-session", handleConfirmStripeSession);
app.get("/api/public/payments/confirm-session", handleConfirmStripeSession);

app.post("/api/payments/stripe/create-checkout-session", protectedRoute((req, res, user) => {
  return handleCreateStripeCheckoutSession(req, res, {
    source: "staff_backend",
    method: "card",
    user
  });
}));

app.post("/api/payments/revolut/create-order", protectedRoute((req, res, user) => {
  return handleCreateStripeCheckoutSession(req, res, {
    source: "staff_backend",
    method: "revolut",
    user
  });
}));

app.post("/api/payments/check", protectedRoute((req, res) => {
  return handleCheckPayment(req, res);
}));

app.post("/api/payments/bank-transfer/create", protectedRoute(handleCreateBankTransfer));

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
