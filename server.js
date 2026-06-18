"use strict";

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "2mb" }));

const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  "https://reustarant-software.web.app",
  "https://reustarant-software.firebaseapp.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

function initFirebaseAdmin() {
  if (admin.apps.length) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable.");
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

initFirebaseAdmin();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

function safeNumber(value, fallback = 0) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function readQty(value) {
  const n = safeNumber(value, 1);
  return n > 0 ? n : 1;
}

function readLineTotal(item) {
  const qty = readQty(item.qty ?? item.quantity ?? item.count);
  const price = safeNumber(item.price ?? item.unitPrice ?? item.unit_price ?? 0);
  return Math.round(qty * price * 100) / 100;
}

async function requireAuth(req, res, next) {
  try {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
      res.status(401).json({ error: "Missing Authorization Bearer token." });
      return;
    }

    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid Firebase auth token." });
  }
}

async function loadOrder(orderId) {
  const id = String(orderId || "").trim();
  if (!id) throw new Error("Missing orderId.");

  const ref = db.collection("orders").doc(id);
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error("Order not found.");
  }

  const data = snap.data() || {};
  let items = Array.isArray(data.items) ? data.items : [];

  if (!items.length) {
    const itemsSnap = await ref.collection("items").get();
    items = itemsSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  }

  const amount = Math.round(items.reduce((sum, item) => {
    return sum + readLineTotal(item);
  }, 0) * 100) / 100;

  return {
    ref,
    id,
    data,
    items,
    amount
  };
}

async function createPaymentDoc(payload) {
  const ref = await db.collection("payments").add({
    ...payload,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return ref.id;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "restaurant-payment-backend"
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "restaurant-payment-backend"
  });
});

app.post("/api/payments/stripe/create-checkout-session", requireAuth, async (req, res) => {
  try {
    const stripe = getStripe();

    if (!stripe) {
      res.status(501).json({ error: "Stripe is not configured. Missing STRIPE_SECRET_KEY." });
      return;
    }

    const {
      orderId,
      tableId,
      tipAmount = 0,
      successUrl,
      cancelUrl
    } = req.body || {};

    const order = await loadOrder(orderId);
    const tip = safeNumber(tipAmount, 0);
    const totalAmount = Math.round((order.amount + tip) * 100) / 100;

    if (totalAmount <= 0) {
      res.status(400).json({ error: "Total amount must be greater than 0." });
      return;
    }

    const paymentId = await createPaymentDoc({
      provider: "stripe",
      method: "card",
      status: "pending",
      paymentStatus: "pending",
      orderId: order.id,
      tableId: String(tableId || order.data.tableId || ""),
      amount: order.amount,
      tipAmount: tip,
      totalAmount,
      currency: "EUR",
      waiterId: req.user.uid
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            unit_amount: Math.round(totalAmount * 100),
            product_data: {
              name: `Restaurant order ${order.id}`
            }
          }
        }
      ],
      success_url: successUrl || `${allowedOrigins[0] || "https://reustarant-software.web.app"}/payment-success.html?provider=stripe&paymentId=${paymentId}&orderId=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${allowedOrigins[0] || "https://reustarant-software.web.app"}/payment-cancel.html?provider=stripe&paymentId=${paymentId}&orderId=${order.id}`,
      metadata: {
        paymentId,
        orderId: order.id,
        tableId: String(tableId || order.data.tableId || "")
      }
    });

    await db.collection("payments").doc(paymentId).set({
      stripeSessionId: session.id,
      checkoutUrl: session.url,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      checkoutUrl: session.url,
      paymentId,
      sessionId: session.id
    });
  } catch (err) {
    console.error("stripe checkout error:", err);
    res.status(500).json({ error: err.message || "Stripe checkout failed." });
  }
});

app.post("/api/payments/revolut/create-order", requireAuth, async (req, res) => {
  try {
    const apiKey = process.env.REVOLUT_API_KEY;

    if (!apiKey) {
      res.status(501).json({ error: "Revolut Merchant API is not configured." });
      return;
    }

    res.status(501).json({
      error: "Revolut endpoint placeholder. Add real Revolut Merchant API integration."
    });
  } catch (err) {
    console.error("revolut error:", err);
    res.status(500).json({ error: err.message || "Revolut payment failed." });
  }
});

app.post("/api/payments/bank-transfer/create", requireAuth, async (req, res) => {
  try {
    const {
      orderId,
      tableId,
      tipAmount = 0
    } = req.body || {};

    const order = await loadOrder(orderId);
    const tip = safeNumber(tipAmount, 0);
    const totalAmount = Math.round((order.amount + tip) * 100) / 100;

    const reference = `ORDER-${String(order.id).slice(0, 8).toUpperCase()}`;

    const paymentId = await createPaymentDoc({
      provider: "bank_transfer",
      method: "bank_transfer",
      status: "pending",
      paymentStatus: "pending",
      orderId: order.id,
      tableId: String(tableId || order.data.tableId || ""),
      amount: order.amount,
      tipAmount: tip,
      totalAmount,
      currency: "EUR",
      bankTransferReference: reference,
      waiterId: req.user.uid
    });

    res.json({
      paymentId,
      status: "pending",
      bankTransferReference: reference,
      bankIban: process.env.BANK_TRANSFER_IBAN || "",
      beneficiary: process.env.BANK_TRANSFER_BENEFICIARY || "",
      totalAmount,
      currency: "EUR"
    });
  } catch (err) {
    console.error("bank transfer error:", err);
    res.status(500).json({ error: err.message || "Bank transfer failed." });
  }
});

app.post("/api/payments/check", requireAuth, async (req, res) => {
  try {
    const {
      paymentId,
      sessionId,
      orderId
    } = req.body || {};

    let paymentRef = null;
    let paymentSnap = null;

    if (paymentId) {
      paymentRef = db.collection("payments").doc(String(paymentId));
      paymentSnap = await paymentRef.get();
    } else if (sessionId) {
      const snap = await db.collection("payments")
        .where("stripeSessionId", "==", String(sessionId))
        .limit(1)
        .get();

      if (!snap.empty) {
        paymentSnap = snap.docs[0];
        paymentRef = paymentSnap.ref;
      }
    } else if (orderId) {
      const snap = await db.collection("payments")
        .where("orderId", "==", String(orderId))
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();

      if (!snap.empty) {
        paymentSnap = snap.docs[0];
        paymentRef = paymentSnap.ref;
      }
    }

    if (!paymentSnap || !paymentSnap.exists) {
      res.status(404).json({ error: "Payment not found." });
      return;
    }

    let payment = {
      id: paymentSnap.id,
      ...(paymentSnap.data() || {})
    };

    if (payment.provider === "stripe" && payment.stripeSessionId) {
      const stripe = getStripe();

      if (stripe) {
        const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);

        if (session.payment_status === "paid") {
          await paymentRef.set({
            status: "paid",
            paymentStatus: "paid",
            stripePaymentIntentId: session.payment_intent || "",
            paidAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });

          payment = {
            ...payment,
            status: "paid",
            paymentStatus: "paid"
          };
        }
      }
    }

    const status = String(payment.status || payment.paymentStatus || "").toLowerCase();

    if (status === "paid" && payment.orderId) {
      await db.collection("orders").doc(String(payment.orderId)).set({
        status: "paid",
        paymentStatus: "paid",
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      if (payment.tableId) {
        await db.collection("tables").doc(String(payment.tableId)).set({
          status: "free",
          activeOrders: [],
          currentOrderId: "",
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }

    res.json({
      paymentId: paymentSnap.id,
      status: payment.status || "pending",
      paymentStatus: payment.paymentStatus || payment.status || "pending",
      provider: payment.provider || "",
      totalAmount: payment.totalAmount || 0,
      currency: payment.currency || "EUR",
      payment
    });
  } catch (err) {
    console.error("check payment error:", err);
    res.status(500).json({ error: err.message || "Payment check failed." });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found.",
    method: req.method,
    path: req.originalUrl
  });
});

app.listen(PORT, () => {
  console.log(`Payment backend running on port ${PORT}`);
  console.log(`Health: /api/health`);
});
