/* ============================================================
   firebase-init.js
   শেয়ার্ড ফাইল — login.html, admin.html, shop-ledger-app.html
   তিনটাতেই এই ফাইলটা লোড করা হয়েছে (compat SDK ব্যবহার করে)
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyD6qmuWkNUrskMIBHq8Z_AQ0N_WT1DL8Is",
  authDomain: "honeybee-984dd.firebaseapp.com",
  projectId: "honeybee-984dd",
  storageBucket: "honeybee-984dd.firebasestorage.app",
  messagingSenderId: "610211112501",
  appId: "1:610211112501:web:9ea40b9060d425e85b737c"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

/* সাব-ইউজার তৈরি করার সময় বর্তমান লগইন সেশন যেন নষ্ট না হয়,
   সেজন্য একটা আলাদা (secondary) firebase app ব্যবহার করা হয় */
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

/* ---------- ছোট হেল্পার ফাংশনগুলো ---------- */

function fbNow() {
  return firebase.firestore.FieldValue.serverTimestamp();
}

async function getMyUserDoc(uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
}

async function getShopDoc(shopId) {
  const snap = await db.collection("shops").doc(shopId).get();
  return snap.exists ? snap.data() : null;
}

async function isSuperAdmin(uid) {
  const snap = await db.collection("superadmins").doc(uid).get();
  return snap.exists;
}

/* ---------- লগইন ব্যর্থ হলে গণনা + অটো-ব্লক ---------- */
const MAX_FAILED_ATTEMPTS = 5;

async function recordFailedLogin(email) {
  const ref = db.collection("loginAttempts").doc(email);
  const snap = await ref.get();
  const count = (snap.exists ? (snap.data().count || 0) : 0) + 1;
  await ref.set({ count, lastAttempt: fbNow() }, { merge: true });

  if (count >= MAX_FAILED_ATTEMPTS) {
    // এই ইমেইলের মালিক কোন শপ, খুঁজে বের করে শপটা ব্লক করে দাও
    const userQuery = await db.collection("users").where("email", "==", email).limit(1).get();
    if (!userQuery.empty) {
      const userData = userQuery.docs[0].data();
      await db.collection("shops").doc(userData.shopId).set({
        status: "blocked",
        blockedReason: "অতিরিক্ত ভুল পাসওয়ার্ড (auto-lock)",
        blockedAt: fbNow()
      }, { merge: true });
    }
  }
  return count;
}

async function clearFailedLogin(email) {
  await db.collection("loginAttempts").doc(email).delete().catch(() => {});
}

/* ---------- session storage (এই ট্যাবে কে লগইন আছে) ---------- */
function saveSession(data) {
  sessionStorage.setItem("bcc-session", JSON.stringify(data));
}
function getSession() {
  try { return JSON.parse(sessionStorage.getItem("bcc-session") || "null"); }
  catch (e) { return null; }
}
function clearSession() {
  sessionStorage.removeItem("bcc-session");
}

/* ============================================================
   localStorage  <->  Firestore  সিঙ্ক ইঞ্জিন
   (মূল অ্যাপের ৬০০০+ লাইন কোড অপরিবর্তিত রেখে, এই লেয়ারটা
   লোকালস্টোরেজকে সার্ভারের সাথে সিঙ্ক করে রাখে)
   ============================================================ */

let __syncShopId = null;
let __syncTimer = null;
const SYNC_DEBOUNCE_MS = 2500;

// আসল localStorage ফাংশনগুলো ব্যাকআপ রাখা
const __origSetItem = Storage.prototype.setItem;
const __origRemoveItem = Storage.prototype.removeItem;
const __origClear = Storage.prototype.clear;

function enableAutoSync(shopId) {
  __syncShopId = shopId;

  Storage.prototype.setItem = function (key, value) {
    __origSetItem.call(this, key, value);
    if (this === window.localStorage) scheduleCloudSync();
  };
  Storage.prototype.removeItem = function (key) {
    __origRemoveItem.call(this, key);
    if (this === window.localStorage) scheduleCloudSync();
  };
  Storage.prototype.clear = function () {
    __origClear.call(this);
    if (this === window.localStorage) scheduleCloudSync();
  };
}

function disableAutoSync() {
  Storage.prototype.setItem = __origSetItem;
  Storage.prototype.removeItem = __origRemoveItem;
  Storage.prototype.clear = __origClear;
  __syncShopId = null;
  if (__syncTimer) clearTimeout(__syncTimer);
}

function scheduleCloudSync() {
  if (!__syncShopId) return;
  if (__syncTimer) clearTimeout(__syncTimer);
  __syncTimer = setTimeout(pushLocalStorageToCloud, SYNC_DEBOUNCE_MS);
}

async function pushLocalStorageToCloud() {
  if (!__syncShopId) return;
  const blob = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    blob[k] = localStorage.getItem(k);
  }
  try {
    await db.collection("shops").doc(__syncShopId)
      .collection("appdata").doc("main")
      .set({ blob: JSON.stringify(blob), updatedAt: fbNow() }, { merge: true });
    setSyncIndicator("ok");
  } catch (e) {
    console.error("Cloud sync failed:", e);
    setSyncIndicator("error");
  }
}

async function pullCloudToLocalStorage(shopId) {
  const snap = await db.collection("shops").doc(shopId)
    .collection("appdata").doc("main").get();
  if (!snap.exists || !snap.data().blob) return false;
  const blob = JSON.parse(snap.data().blob);
  __origClear.call(localStorage);
  Object.keys(blob).forEach(k => __origSetItem.call(localStorage, k, blob[k]));
  return true;
}

function setSyncIndicator(state) {
  const el = document.getElementById("cloudSyncDot");
  if (!el) return;
  el.style.background = state === "ok" ? "#27633f" : state === "error" ? "#a3372c" : "#c9a96a";
  el.title = state === "ok" ? "সার্ভারের সাথে সিঙ্ক করা আছে" : state === "error" ? "সিঙ্ক ব্যর্থ — ইন্টারনেট চেক করুন" : "সিঙ্ক হচ্ছে...";
}
