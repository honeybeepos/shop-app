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
// লগইন যেন ডিভাইসেই স্থায়ীভাবে থেকে যায় (অ্যাপ মিনিমাইজ/বন্ধ করে আবার খুললেও লগইন থাকবে)
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
const db = firebase.firestore();

/* 🖼️ Cloud Storage — শুধু shop-ledger-app.html-এ SDK লোড করা থাকে
   (Product Image ফিচারের জন্য), login.html/admin.html-এ এই SDK নেই।
   এই ফাইলটা তিনটা পেজেই শেয়ার হয় বলে conditional/নিরাপদভাবে init করা
   হচ্ছে — SDK লোড না থাকলে storage = null থাকবে, কোনো এরর ছুড়বে না,
   login.html/admin.html-এর কোনো ফাংশনালিটি প্রভাবিত হবে না। */
const storage = (typeof firebase.storage === "function") ? firebase.storage() : null;

/* অফলাইন-ফার্স্ট: ইন্টারনেট না থাকলেও অ্যাপ যেন সেল/এন্ট্রি বন্ধ না করে।
   এটা চালু থাকলে Firestore ডেটা ও পেন্ডিং রাইট মোবাইলের IndexedDB-তে
   জমা থাকে, এবং ইন্টারনেট ফিরলে নিজে থেকেই সার্ভারের সাথে সিঙ্ক হয়ে যায় —
   কোনো ম্যানুয়াল কাজ লাগে না। */
db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn("অফলাইন মোড চালু করা যায়নি:", err.code);
});

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

// 🐞 বাগ-ফিক্স নোট: ইমেইল সবসময় trim+lowercase করে normalize করা হচ্ছে —
// নাহলে একই ইমেইল আলাদা ছোট/বড় হাতের অক্ষরে টাইপ করলে আলাদা
// loginAttempts ডকুমেন্ট তৈরি হয়ে যেত, আর গণনাও ভুল/অসামঞ্জস্যপূর্ণ হতো।
function normalizeLoginEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/* ⏱️ তালা নিজে থেকেই খুলে যায়।
   ⚠️ আগে গণনাটা কখনো শূন্য হতো না — একবার ৫ ছুঁলে তারপর প্রতিবার
      ভুল হলেই "একাউন্ট ব্লক হয়ে গেছে, এডমিনের সাথে যোগাযোগ করুন"
      দেখাত, আর বেরোনোর কোনো পথ থাকত না। অথচ বেশিরভাগ ক্ষেত্রে
      কিছুই ব্লক হতো না — শুধু লেখাটাই ভয় দেখাত।
      এখন শেষ ভুল চেষ্টার ১৫ মিনিট পর গণনা নিজে থেকেই শূন্য হয়ে যায়। */
const LOGIN_LOCK_MINUTES = 15;

function __attemptAgeMin(data){
  const t = data && data.lastAttempt;
  if (!t) return Infinity;                       // পুরনো নথি — মেয়াদ শেষ ধরি
  const ms = t.toMillis ? t.toMillis() : (t.seconds ? t.seconds * 1000 : 0);
  if (!ms) return Infinity;
  return (Date.now() - ms) / 60000;
}

/* ফেরত দেয় { count, locked, waitMin } — login.html এটা দেখে
   কত মিনিট অপেক্ষা করতে হবে সেটা বলতে পারে। */
async function recordFailedLogin(email) {
  const key = normalizeLoginEmail(email);
  const ref = db.collection("loginAttempts").doc(key);
  const snap = await ref.get();
  const prev = snap.exists ? snap.data() : null;
  const expired = !prev || __attemptAgeMin(prev) >= LOGIN_LOCK_MINUTES;
  const count = (expired ? 0 : (prev.count || 0)) + 1;
  /* মেয়াদ ফুরোলে autoLockApplied-ও মুছে দিই, নইলে Cloud Function
     ভাবত এই একাউন্টে আগেই তালা দেওয়া হয়ে গেছে। */
  await ref.set({ count, lastAttempt: fbNow(),
                  autoLockApplied: expired ? false : (prev && prev.autoLockApplied) || false },
                { merge: true });
  // 🐞 বাগ-ফিক্স: আগে এখানেই ক্লায়েন্ট থেকে সরাসরি shops/{shopId}.status =
  // "blocked" লেখার চেষ্টা হতো — কিন্তু ব্যর্থ-লগইনের মুহূর্তে সাধারণত
  // request.auth == null থাকে (সাইন-ইনই তো ব্যর্থ হয়েছে), আর
  // firestore.rules-এ এই রাইট isSignedIn() দাবি করে — তাই এই রাইট
  // বেশিরভাগ সময়ই নীরবে ব্যর্থ হতো, অথচ ব্যবহারকারীকে "একাউন্ট ব্লক হয়ে
  // গেছে" মেসেজ দেখানো হতো — বাস্তবে একাউন্ট ব্লক না হওয়া সত্ত্বেও।
  // এখন এই এনফোর্সমেন্ট সম্পূর্ণভাবে functions/index.js-এর
  // onFailedLoginThreshold Cloud Function-এ সরিয়ে নেওয়া হয়েছে — সেটা
  // Admin SDK দিয়ে চলে (rules বাইপাস করে), তাই ক্লায়েন্টের auth অবস্থা
  // নির্বিশেষে নির্ভরযোগ্যভাবে কাজ করবে। এছাড়া userData.shopId
  // undefined হলে (ড্রাইভার/রাইডার একাউন্ট) doc(undefined) কল করে যে
  // ক্র্যাশ হতো, সেটাও এভাবে এড়ানো গেল।
  return { count: count, locked: count >= MAX_FAILED_ATTEMPTS, waitMin: LOGIN_LOCK_MINUTES };
}

async function clearFailedLogin(email) {
  const key = normalizeLoginEmail(email);
  await db.collection("loginAttempts").doc(key).delete().catch(() => {});
}

/* ---------- ডিভাইস আইডি ----------
   প্রতিটা ব্রাউজার ট্যাব/ডিভাইসকে একটা এলোমেলো আইডি দেওয়া হয়। যখন এই ডিভাইস
   নিজেই ডেটা push করে, তখন সেই সাথে এই আইডিটাও পাঠানো হয়। পরে realtime listener
   যখন পরিবর্তন দেখে, তখন এই আইডি মিলিয়ে বুঝতে পারে এটা নিজেরই পাঠানো পরিবর্তন
   নাকি অন্য কারো (যেমন সাব-ইউজারের) — নিজেরটা হলে আবার টেনে/রিফ্রেশ করার দরকার নেই। */
const __deviceId = (() => {
  let id = sessionStorage.getItem("bcc-device-id");
  if (!id) {
    id = "dev-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
    sessionStorage.setItem("bcc-device-id", id);
  }
  return id;
})();

/* ---------- session storage (এই ডিভাইসে কে লগইন আছে) ----------
   sessionStorage-এর বদলে localStorage ব্যবহার করা হচ্ছে — অ্যাপ মিনিমাইজ/ব্যাকগ্রাউন্ডে
   গেলে Android মাঝে মাঝে সাথে সাথে ব্যবহার করা WebView প্রসেস বন্ধ করে দেয়, তখন
   sessionStorage মুছে যায় এবং লগইন সেশন হারিয়ে ফেলে (অটো-লগআউটের মতো মনে হয়)।
   localStorage ডিভাইসেই থেকে যায়, তাই মিনিমাইজ করলেও লগইন অবস্থা বজায় থাকবে। */
function saveSession(data) {
  localStorage.setItem("bcc-session", JSON.stringify(data));
}
function getSession() {
  try { return JSON.parse(localStorage.getItem("bcc-session") || "null"); }
  catch (e) { return null; }
}
function clearSession() {
  localStorage.removeItem("bcc-session");
}

/* ============================================================
   localStorage  <->  Firestore  সিঙ্ক ইঞ্জিন  (নতুন গঠন, অক্টোবর ২০২৬)
   ============================================================
   আগে: পুরো localStorage এক JSON হয়ে একটামাত্র নথিতে যেত
        (shops/{shopId}/appdata/main) — Firestore-এ এক নথি সর্বোচ্চ ১ MiB,
        তাই বিক্রি বাড়লে কয়েক মাসে সেভ চিরতরে বন্ধ হয়ে যেত। আর দুই ফোনে
        কাজ করলে শেষে যে লিখত সে জিতত, আগেরজনের কাজ মুছে যেত।

   এখন: সব যায় shops/{shopId}/ledger ঘরে, প্রতিটা রেকর্ড আলাদা নথি:
        entries~id:K7QM...      ← প্রতিটা বিক্রি আলাদা
        customers~p:017...      ← প্রতিটা কাস্টমার আলাদা
        products~id:...  expenses~id:...  suppliers~id:...  ইত্যাদি
        kv~shop-title           ← ছোট সেটিং, এক কী = এক নথি
   শুধু যেটা বদলেছে সেটাই লেখা হয়। কোনটা বদলেছে তা বোঝা যায় একটা
   "ছায়া-কপি" (প্রতিটা রেকর্ডের ছোট হ্যাশ) মিলিয়ে।

   মোছা রেকর্ড নথি থেকে মোছা হয় না — d:true দাগ দেওয়া হয় (tombstone),
   যাতে অন্য ফোনও জানতে পারে যে এটা মোছা হয়েছে।

   প্রতিটা নথিতে u = সার্ভারের সময়। প্রতিটা ফোন মনে রাখে শেষ কোন সময়
   পর্যন্ত দেখেছে (watermark), পরের বার শুধু তার পরের নথিগুলোই পড়ে —
   তাই অ্যাপ খুললে পুরো খাতা আবার পড়তে হয় না।

   POS-এর কোডে কোনো বদল লাগেনি — আগের মতোই localStorage-এ লেখে,
   আর বাইরের ফাংশনগুলোর নামও একই (pushLocalStorageToCloud,
   pullCloudToLocalStorage, watchAppDataChanges, enableAutoSync ...)।
   ============================================================ */

let __syncShopId = null;
let __syncTimer = null;
const SYNC_DEBOUNCE_MS = 2500;

// আসল localStorage ফাংশনগুলো ব্যাকআপ রাখা
const __origSetItem = Storage.prototype.setItem;
const __origGetItem = Storage.prototype.getItem;
const __origRemoveItem = Storage.prototype.removeItem;
const __origClear = Storage.prototype.clear;

/* 🇸🇦 কর চালানের খাতা (ZATCA) এই সিঙ্কের বাইরে — চালানগুলো নিজের আলাদা
   ঘরে যায় (shops/{shopId}/zatcaInvoices), যেগুলো কখনো একে অপরকে চাপা দেয় না। */
const ZATCA_LOCAL_KEYS = ["zatca-egs-unit", "zatca-icv", "zatca-ledger"];

const LEDGER_COL = "ledger";
const SYNC_META_PREFIX = "__hbsync";          // সিঙ্কের নিজের হিসাব — কখনো ক্লাউডে যায় না
const SHADOW_KEY = "__hbsync-shadow";         // ছায়া-কপি (কোন রেকর্ড শেষবার কেমন ছিল)
const WM_KEY = "__hbsync-wm";                 // { shopId, wm } — শেষ কোন সময় পর্যন্ত দেখা হয়েছে
const SYNC_OVERLAP_MS = 60 * 1000;            // নিরাপত্তার জন্য ১ মিনিট আগে থেকে পড়া
const KV_CHUNK = 300000;                      // বড় সেটিং (যেমন লোগো) এর চেয়ে বড় হলে টুকরো করে রাখা
const MAX_ROW_CHARS = 300000;                 // একটা রেকর্ড এর চেয়ে বড় হলে পাঠানো হয় না (১ MiB সীমা)

/* শুধু এই ডিভাইসের জিনিস — দোকানের ডেটা না, তাই ক্লাউডে যায় না।
   (আগে ট্যাব বদলালেও পুরো খাতা আবার লেখা হতো — এখন এগুলো সিঙ্কই হয় না) */
const LOCAL_ONLY_KEYS = [
  "bcc-session", "recent-sale-backup",
  "bcc-last-tab", "bcc-last-program", "bcc-catfold-open", "desk-biz-collapsed",
  "hb-notebook-zoom", "hb_bee_ringtone_enabled"
].concat(ZATCA_LOCAL_KEYS);

function isLocalOnlyKey(k) {
  return !k || k.indexOf(SYNC_META_PREFIX) === 0 || LOCAL_ONLY_KEYS.indexOf(k) !== -1;
}

/* যে কী-গুলো রেকর্ডের তালিকা (অ্যারে) — এগুলো ভেঙে প্রতিটা রেকর্ড আলাদা নথি হয়।
   ডান পাশের নামটা নথির নামের শুরুতে বসে (Firebase কনসোলে চেনা সহজ হয়)। */
const ROW_KEYS = {
  "phone-shop-entries": "entries",
  "phone-shop-customers": "customers",
  "bcc-products": "products",
  "bcc-categories": "categories",
  "shop-suppliers": "suppliers",
  "shop-supplier-txns": "supplierTxns",
  "shop-expenses": "expenses",
  "shop-employees": "employees",
  "shop-employee-txns": "employeeTxns",
  "bcc-due-log": "dueLog",
  "bcc-extra-income": "extraIncome",
  "shop-cash-adjustments": "cashAdj",
  "cash-bank-transfers": "cashBank",
  "honeybee-orders": "orders",
  "bcc-reco-history": "recoHistory"
};

/* মোছার তালিকা — দুই দিক থেকে এলে দুটোই রাখা হয় (union), কখনো ছোট হয় না */
const UNION_KEYS = [
  "phone-shop-deleted-entry-ids", "shop-deleted-expense-ids",
  "phone-shop-deleted-customer-keys", "phone-shop-restored-customer-keys",
  "bcc-deleted-product-ids", "bcc-deleted-category-ids"
];

/* ---------- ছোট হেল্পার ---------- */

// দ্রুত ৫৩-বিটের হ্যাশ (cyrb53) — শুধু "বদলেছে কিনা" বোঝার জন্য
function __h(str) {
  if (str === null || str === undefined) return "-";
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function __enc(s) { return encodeURIComponent(String(s)); }

function __ledgerCol(shopId) {
  return db.collection("shops").doc(shopId).collection(LEDGER_COL);
}

function safeParseArray(str) {
  if (!str) return [];
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

/* ডিলিট করা কাস্টমারের tombstone লিস্ট {key, at} আকারে (পুরনো ["k1","k2"] ফরম্যাটও চলে) */
function normalizeTombList(arr) {
  return arr.map(x => (typeof x === "string") ? { key: x, at: 0 } : x).filter(x => x && x.key);
}
function mergeTombLists(localArr, cloudArr) {
  const merged = {};
  [...normalizeTombList(localArr), ...normalizeTombList(cloudArr)].forEach(({ key, at }) => {
    if (!merged[key] || (at || 0) > merged[key].at) merged[key] = { key, at: at || 0 };
  });
  return Object.values(merged);
}
function activeDeletedKeys(deletedList, restoredList) {
  const restoredAt = {};
  normalizeTombList(restoredList).forEach(({ key, at }) => { restoredAt[key] = at || 0; });
  return normalizeTombList(deletedList)
    .filter(({ key, at }) => !(key in restoredAt) || restoredAt[key] < (at || 0))
    .map(({ key }) => key);
}

function __unionValue(k, localRaw, remoteRaw) {
  const a = safeParseArray(localRaw), b = safeParseArray(remoteRaw);
  if (k === "phone-shop-deleted-customer-keys" || k === "phone-shop-restored-customer-keys") {
    return JSON.stringify(mergeTombLists(a, b));
  }
  const seen = {}, out = [];
  a.concat(b).forEach(x => { const s = JSON.stringify(x); if (!seen[s]) { seen[s] = 1; out.push(x); } });
  return JSON.stringify(out);
}

/* প্রতিটা রেকর্ডের পরিচয় (identity):
   কাস্টমার → ফোন থাকলে "p:ফোন", না থাকলে "n:নাম" (অ্যাপ নিজেও এভাবেই চেনে)
   বাকিরা  → "id:<id>"; id না থাকলে লেখার হ্যাশ দিয়ে "h:..."
   একই পরিচয় দুবার থাকলে দ্বিতীয়টার শেষে "#2" — কিছুই হারায় না। */
function __rowIdentities(k, arr) {
  const seen = {};
  return arr.map(it => {
    let id;
    if (k === "phone-shop-customers" && it && typeof it === "object") {
      id = it.phone ? "p:" + it.phone : "n:" + (it.name || "");
    } else if (it && typeof it === "object" &&
               ((typeof it.id === "string" && it.id !== "") || typeof it.id === "number")) {
      id = "id:" + it.id;
    } else {
      id = "h:" + __h(JSON.stringify(it));
    }
    if (seen[id]) { seen[id]++; id = id + "#" + seen[id]; } else { seen[id] = 1; }
    return id;
  });
}

function __loadShadow() {
  try {
    const s = JSON.parse(__origGetItem.call(localStorage, SHADOW_KEY) || "null");
    return (s && s.keys) ? s : { keys: {} };
  } catch (e) { return { keys: {} }; }
}
function __saveShadow(s) {
  try { __origSetItem.call(localStorage, SHADOW_KEY, JSON.stringify(s)); }
  catch (e) { console.warn("সিঙ্কের ছায়া-কপি সেভ হয়নি:", e); }
}
function __loadWm() {
  try { return JSON.parse(__origGetItem.call(localStorage, WM_KEY) || "null"); } catch (e) { return null; }
}
function __saveWm(shopId, wm) {
  try { __origSetItem.call(localStorage, WM_KEY, JSON.stringify({ shopId: shopId, wm: wm || 0 })); } catch (e) {}
}
function __tsMillis(t) {
  if (!t) return 0;
  if (t.toMillis) return t.toMillis();
  return t.seconds ? t.seconds * 1000 : 0;
}

/* সব সিঙ্ক কাজ (পাঠানো/আনা) একটার পর একটা চলে — একসাথে দুটো চললে
   ছায়া-কপি গোলমাল হতে পারত। */
let __syncChain = Promise.resolve();
function __enqueue(fn) {
  const p = __syncChain.then(fn, fn);
  __syncChain = p.catch(() => {});
  return p;
}

/* ---------- localStorage ফাঁদ ---------- */

function enableAutoSync(shopId) {
  __syncShopId = shopId;

  Storage.prototype.setItem = function (key, value) {
    __origSetItem.call(this, key, value);
    if (this === window.localStorage && !isLocalOnlyKey(key)) scheduleCloudSync();
  };
  Storage.prototype.removeItem = function (key) {
    // সিঙ্কের নিজের হিসাব মোছা যাবে না — নইলে "কী মোছা হলো" সেটাই আর বোঝা যেত না
    if (this === window.localStorage && String(key).indexOf(SYNC_META_PREFIX) === 0) return;
    __origRemoveItem.call(this, key);
    if (this === window.localStorage && !isLocalOnlyKey(key)) scheduleCloudSync();
  };
  Storage.prototype.clear = function () {
    if (this !== window.localStorage) return __origClear.call(this);
    const keep = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(SYNC_META_PREFIX) === 0) keep[k] = __origGetItem.call(localStorage, k);
    }
    __origClear.call(this);
    Object.keys(keep).forEach(k => __origSetItem.call(localStorage, k, keep[k]));
    scheduleCloudSync();
  };
}

function disableAutoSync() {
  Storage.prototype.setItem = __origSetItem;
  Storage.prototype.removeItem = __origRemoveItem;
  Storage.prototype.clear = __origClear;
  __syncShopId = null;
  if (__syncTimer) clearTimeout(__syncTimer);
  stopWatchingAppDataChanges();
}

function scheduleCloudSync() {
  if (!__syncShopId) return;
  if (__syncTimer) clearTimeout(__syncTimer);
  __syncTimer = setTimeout(() => pushLocalStorageToCloud().catch(() => {}), SYNC_DEBOUNCE_MS);
}

/* ============================================================
   পাঠানো (push) — শুধু বদলানো রেকর্ড
   ============================================================ */

function pushLocalStorageToCloud() {
  if (!__syncShopId) return Promise.resolve();
  if (__syncTimer) { clearTimeout(__syncTimer); __syncTimer = null; }
  return __enqueue(() => __doPush(__syncShopId));
}

function __rowDocId(k, id) { return ROW_KEYS[k] + "~" + __enc(id); }
function __kvDocId(k) { return "kv~" + __enc(k); }
function __kvPartId(k, p) { return "kvp~" + __enc(k) + "~" + p; }

function __tombRows(k, rows, ops) {
  Object.keys(rows || {}).forEach(id => {
    ops.push({ id: __rowDocId(k, id), data: { t: "row", k: k, i: id, d: true, o: rows[id][1] } });
  });
}

function __diffRows(k, arr, rh, old, ops, next, now) {
  const ids = __rowIdentities(k, arr);
  const oldRows = (old && old.rows) || {};
  const hasOld = Object.keys(oldRows).length > 0;
  const newRows = {};

  /* ক্রম (o) — নতুন রেকর্ড তালিকার শুরুতে বসেছে (unshift) নাকি শেষে (push),
     সেটা মনে রাখা হয়, যাতে অন্য ফোনে বা নতুন ফোনে একই ক্রমে সাজানো যায়।
     ঋণাত্মক o = শুরুতে (নতুনটা আরও ছোট), ধনাত্মক = শেষে। */
  let headCount = 0;
  if (hasOld) {
    for (let j = 0; j < ids.length; j++) { if (oldRows[ids[j]]) { headCount = j; break; } }
  }
  let tailJ = 0;
  for (let j = 0; j < arr.length; j++) {
    const id = ids[j];
    const v = JSON.stringify(arr[j]);
    const h = __h(v);
    const prev = oldRows[id];
    let o;
    if (prev) o = prev[1];
    else if (!hasOld) o = j;
    else if (j < headCount) o = -(now * 1000 + (headCount - j));
    else o = now * 1000 + (tailJ++);
    newRows[id] = [h, o];
    if (prev && prev[0] === h) continue;
    if (v.length > MAX_ROW_CHARS) {
      console.warn("রেকর্ড অনেক বড়, ক্লাউডে পাঠানো যাচ্ছে না:", k, id, v.length);
      continue;
    }
    ops.push({ id: __rowDocId(k, id), data: { t: "row", k: k, i: id, v: v, h: h, o: o } });
  }
  Object.keys(oldRows).forEach(id => {
    if (!newRows[id]) ops.push({ id: __rowDocId(k, id), data: { t: "row", k: k, i: id, d: true, o: oldRows[id][1] } });
  });
  if (old && old.kv) ops.push({ id: __kvDocId(k), data: { t: "kv", k: k, d: true } });
  next[k] = { rh: rh, rows: newRows };
}

function __diffKv(k, raw, rh, old, ops, next) {
  const n = Math.max(1, Math.ceil(raw.length / KV_CHUNK));
  for (let p = 1; p < n; p++) {
    ops.push({ id: __kvPartId(k, p), data: { t: "kvp", k: k, p: p, v: raw.slice(p * KV_CHUNK, (p + 1) * KV_CHUNK) } });
  }
  // মাথার নথি সবার শেষে — যাতে অন্য ফোন মাথা দেখার আগেই টুকরোগুলো পৌঁছে যায়
  ops.push({ id: __kvDocId(k), data: { t: "kv", k: k, v: raw.slice(0, KV_CHUNK), n: n, h: rh } });
  if (old && old.rows) __tombRows(k, old.rows, ops);
  next[k] = { rh: rh, kv: 1, n: n };
}

async function __commitOps(shopId, ops) {
  const col = __ledgerCol(shopId);
  let batch = db.batch(), count = 0, size = 0;
  const commits = [];
  for (const op of ops) {
    const data = Object.assign({}, op.data, { u: fbNow(), by: __deviceId });
    batch.set(col.doc(op.id), data);
    count++; size += (op.data.v ? op.data.v.length : 0) + 200;
    if (count >= 400 || size >= 2500000) {
      await batch.commit();        // ক্রম বজায় রাখতে একটার পর একটা
      batch = db.batch(); count = 0; size = 0;
    }
  }
  if (count) commits.push(batch.commit());
  await Promise.all(commits);
}

async function __doPush(shopId) {
  if (!shopId || shopId !== __syncShopId) return;
  const shadow = __loadShadow();
  const ops = [];
  const next = {};
  const present = {};
  const now = Date.now();

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (isLocalOnlyKey(k)) continue;
    present[k] = 1;
    const raw = __origGetItem.call(localStorage, k);
    if (raw === null) continue;
    const rh = __h(raw);
    const old = shadow.keys[k];
    if (old && old.rh === rh) continue;               // এই কী-তে কিছুই বদলায়নি
    if (ROW_KEYS[k]) {
      let arr = null;
      try { arr = JSON.parse(raw); } catch (e) {}
      if (Array.isArray(arr)) { __diffRows(k, arr, rh, old, ops, next, now); continue; }
    }
    __diffKv(k, raw, rh, old, ops, next);
  }
  // localStorage থেকে পুরো কী-টাই মুছে গেছে (যেমন ফ্যাক্টরি রিসেট)
  Object.keys(shadow.keys).forEach(k => {
    if (present[k] || isLocalOnlyKey(k)) return;
    const old = shadow.keys[k];
    if (old.rows) __tombRows(k, old.rows, ops);
    if (old.kv) ops.push({ id: __kvDocId(k), data: { t: "kv", k: k, d: true } });
    next[k] = null;
  });

  if (ops.length) {
    setSyncIndicator("busy");
    try {
      await __commitOps(shopId, ops);
    } catch (e) {
      console.error("Cloud sync failed:", e);
      setSyncIndicator("error");
      throw e; // await করা কলার (যেমন সেভ-কনফার্মেশন ইন্ডিকেটর) যেন ব্যর্থতা বুঝতে পারে
    }
  }
  if (Object.keys(next).length) {
    Object.keys(next).forEach(k => { if (next[k] === null) delete shadow.keys[k]; else shadow.keys[k] = next[k]; });
    __saveShadow(shadow);
  }
  setSyncIndicator("ok");
}

/* ============================================================
   আনা (pull) — অন্য ফোনের পরিবর্তন localStorage-এ বসানো
   ============================================================
   নিয়ম: এই ফোনে যে রেকর্ড বদলানো হয়েছে কিন্তু এখনো পাঠানো হয়নি,
   সেটা অন্য ফোনের লেখা দিয়ে চাপা পড়ে না — পরের push-এ এটাই যাবে।
   বাকি সব ক্ষেত্রে অন্য ফোনের নতুন লেখা বসে যায় — প্রতিটা রেকর্ড আলাদাভাবে। */

async function __assembleKv(shopId, d, partsById) {
  if (!d.n || d.n <= 1) return d.v || "";
  let s = d.v || "";
  for (let p = 1; p < d.n; p++) {
    const pid = __kvPartId(d.k, p);
    let part = partsById && partsById[pid];
    if (!part) {
      const snap = await __ledgerCol(shopId).doc(pid).get();
      part = snap.exists ? snap.data() : null;
    }
    if (!part || typeof part.v !== "string") return null;
    s += part.v;
  }
  return (__h(s) === d.h) ? s : null;   // টুকরো এখনো পুরো পৌঁছায়নি — পরের বার
}

async function __applyRemote(shopId, docs) {
  const shadow = __loadShadow();
  const byKey = {};
  let wm = 0;
  docs.forEach(d => {
    const ms = __tsMillis(d.u);
    if (ms > wm) wm = ms;
    if (!d || !d.k || d.t === "kvp" || isLocalOnlyKey(d.k)) return;
    if (d.by === __deviceId) return;                 // নিজের পাঠানো — আগেই আছে
    (byKey[d.k] = byKey[d.k] || []).push(d);
  });

  let changed = false;
  for (const k of Object.keys(byKey)) {
    const list = byKey[k];
    const raw = __origGetItem.call(localStorage, k);
    const sh = shadow.keys[k];
    const keyClean = sh ? (sh.rh === __h(raw)) : (raw === null);

    const rows = list.filter(d => d.t === "row");
    const kvs = list.filter(d => d.t === "kv");

    if (rows.length) {
      let arr = safeParseArray(raw);
      const shRows = (sh && sh.rows) ? Object.assign({}, sh.rows) : {};
      const ids = __rowIdentities(k, arr);
      const idx = {};
      ids.forEach((id, j) => { idx[id] = j; });
      const remove = {};
      const heads = [], tails = [];
      let keyChanged = false;

      rows.forEach(d => {
        const id = d.i;
        const j = idx[id];
        const prev = shRows[id];
        if (j !== undefined) {
          const localH = __h(JSON.stringify(arr[j]));
          if (!keyClean && (!prev || prev[0] !== localH)) return;   // এখানে বদলানো, পাঠানো বাকি — এটাই থাকবে
          if (d.d) { remove[j] = 1; delete shRows[id]; keyChanged = true; return; }
          if (d.h === localH) { shRows[id] = [d.h, d.o]; return; }
          try { arr[j] = JSON.parse(d.v); } catch (e) { return; }
          shRows[id] = [d.h, d.o]; keyChanged = true;
        } else {
          if (d.d) { delete shRows[id]; return; }
          if (prev && !keyClean) return;                             // এখানে মোছা, পাঠানো বাকি
          (d.o < 0 ? heads : tails).push(d);
        }
      });

      if (Object.keys(remove).length) arr = arr.filter((_, j) => !remove[j]);
      heads.sort((a, b) => b.o - a.o).forEach(d => {
        try { arr.unshift(JSON.parse(d.v)); shRows[d.i] = [d.h, d.o]; keyChanged = true; } catch (e) {}
      });
      tails.sort((a, b) => a.o - b.o).forEach(d => {
        try { arr.push(JSON.parse(d.v)); shRows[d.i] = [d.h, d.o]; keyChanged = true; } catch (e) {}
      });

      let newRaw = raw;
      if (keyChanged) {
        newRaw = JSON.stringify(arr);
        __origSetItem.call(localStorage, k, newRaw);
        changed = true;
      }
      // এখানে পাঠানো-বাকি কিছু থাকলে rh খালি রাখা হয়, যাতে পরের push আবার মিলিয়ে দেখে
      shadow.keys[k] = { rh: keyClean ? __h(newRaw) : "", rows: shRows };
    }

    if (kvs.length) {
      const d = kvs.reduce((a, b) => (__tsMillis(b.u) >= __tsMillis(a.u) ? b : a));
      if (d.d) {
        if (sh && sh.rows) continue;                 // কী-টা এখন রেকর্ড-তালিকা হিসেবে চলছে
        if (keyClean && raw !== null) { __origRemoveItem.call(localStorage, k); changed = true; }
        if (keyClean) delete shadow.keys[k];
        continue;
      }
      const v = await __assembleKv(shopId, d, null);
      if (v === null) continue;
      if (UNION_KEYS.indexOf(k) !== -1) {
        const merged = __unionValue(k, raw, v);
        if (merged !== raw) { __origSetItem.call(localStorage, k, merged); changed = true; }
        // মিলানো তালিকা দূরের তালিকার চেয়ে বড় হলে সেটা আবার পাঠাতে হবে
        shadow.keys[k] = { rh: (merged === v) ? __h(merged) : "", kv: 1, n: d.n || 1 };
        continue;
      }
      if (!keyClean) continue;                       // এখানে বদলানো, পাঠানো বাকি — এটাই থাকবে
      if (v !== raw) { __origSetItem.call(localStorage, k, v); changed = true; }
      shadow.keys[k] = { rh: __h(v), kv: 1, n: d.n || 1 };
    }
  }

  __saveShadow(shadow);
  if (wm) {
    const meta = __loadWm();
    if (!meta || meta.shopId !== shopId || wm > (meta.wm || 0)) __saveWm(shopId, wm);
  }
  return changed;
}

/* নতুন ফোন / প্রথমবার: পুরো খাতা একবার পড়ে localStorage নতুন করে বানানো */
async function __fullLoad(shopId) {
  const snap = await __ledgerCol(shopId).get();

  // এই ডিভাইসের নিজের জিনিস (লগইন, কর চালান, স্ক্রিনের পছন্দ) সরিয়ে রাখা
  const keepLocal = {};
  LOCAL_ONLY_KEYS.forEach(k => {
    const v = __origGetItem.call(localStorage, k);
    if (v !== null) keepLocal[k] = v;
  });
  const restoreLocal = () => Object.keys(keepLocal).forEach(k => __origSetItem.call(localStorage, k, keepLocal[k]));

  if (snap.empty) {
    /* ক্লাউডের নতুন ঘর খালি। পুরনো এক-নথির খাতা থাকলে সেটা এনে বসানো হয় —
       পরের push নিজে থেকেই সেটা ভেঙে নতুন ঘরে তুলে দেবে (একবারের স্থানান্তর)। */
    let legacy = null;
    try {
      const old = await db.collection("shops").doc(shopId).collection("appdata").doc("main").get();
      if (old.exists && old.data().blob) legacy = JSON.parse(old.data().blob);
    } catch (e) { console.warn("পুরনো খাতা পড়া যায়নি:", e); }

    const prevMeta = __loadWm();
    if (legacy || (prevMeta && prevMeta.shopId && prevMeta.shopId !== shopId)) {
      __origClear.call(localStorage);
      restoreLocal();
      if (legacy) Object.keys(legacy).forEach(k => {
        if (!isLocalOnlyKey(k)) __origSetItem.call(localStorage, k, legacy[k]);
      });
    }
    __saveShadow({ keys: {} });
    __saveWm(shopId, 0);
    return !!legacy;
  }

  const rowsByKey = {}, kvs = [], parts = {};
  let wm = 0;
  snap.forEach(doc => {
    const d = doc.data();
    const ms = __tsMillis(d.u);
    if (ms > wm) wm = ms;
    if (!d.k || isLocalOnlyKey(d.k)) return;
    if (d.t === "kvp") { parts[doc.id] = d; return; }
    if (d.d) return;
    if (d.t === "row") (rowsByKey[d.k] = rowsByKey[d.k] || []).push(d);
    else if (d.t === "kv") kvs.push(d);
  });

  const shadow = { keys: {} };
  const values = {};
  Object.keys(rowsByKey).forEach(k => {
    const list = rowsByKey[k].sort((a, b) => a.o - b.o);
    const arr = [], shRows = {};
    list.forEach(d => {
      try { arr.push(JSON.parse(d.v)); shRows[d.i] = [d.h, d.o]; } catch (e) {}
    });
    values[k] = JSON.stringify(arr);
    shadow.keys[k] = { rh: __h(values[k]), rows: shRows };
  });
  for (const d of kvs) {
    if (rowsByKey[d.k]) continue;
    const v = await __assembleKv(shopId, d, parts);
    if (v === null) continue;
    values[d.k] = v;
    shadow.keys[d.k] = { rh: __h(v), kv: 1, n: d.n || 1 };
  }

  __origClear.call(localStorage);
  restoreLocal();
  Object.keys(values).forEach(k => __origSetItem.call(localStorage, k, values[k]));
  __saveShadow(shadow);
  __saveWm(shopId, wm);
  return true;
}

async function __doPull(shopId) {
  const meta = __loadWm();
  if (!meta || meta.shopId !== shopId) return __fullLoad(shopId);
  const since = firebase.firestore.Timestamp.fromMillis(Math.max(0, (meta.wm || 0) - SYNC_OVERLAP_MS));
  const snap = await __ledgerCol(shopId).where("u", ">", since).get();
  const docs = [];
  snap.forEach(doc => docs.push(doc.data()));
  return __applyRemote(shopId, docs);
}

function pullCloudToLocalStorage(shopId) {
  return __enqueue(() => __doPull(shopId));
}

/* ============================================================
   রিয়েলটাইম — অন্য ফোন কিছু পাঠালে সাথে সাথে পাওয়া
   ============================================================
   Firestore-এর onSnapshot একটা লাইভ সংযোগ খুলে রাখে। শুধু শেষ দেখা
   সময়ের পরের নথিগুলো শোনে — পুরো খাতা না। */
let __appDataUnsubscribe = null;
let __watchGen = 0;

function watchAppDataChanges(shopId, onRemoteChange) {
  stopWatchingAppDataChanges(); // আগে চালু কোনো লিসেনার থাকলে বন্ধ করে নতুন করে বসানো
  const gen = ++__watchGen;

  // প্রথম টেনে আনা (pull) শেষ হওয়ার পরেই শোনা শুরু — তখন "শেষ দেখা সময়" জানা থাকে,
  // নইলে পুরো খাতা আবার পড়া হতো
  __enqueue(() => {
    if (gen !== __watchGen) return;
    const meta = __loadWm();
    const wm = (meta && meta.shopId === shopId) ? (meta.wm || 0) : 0;
    const since = firebase.firestore.Timestamp.fromMillis(Math.max(0, wm - SYNC_OVERLAP_MS));

    __appDataUnsubscribe = __ledgerCol(shopId).where("u", ">", since)
      .onSnapshot((snap) => {
        const docs = [];
        snap.docChanges().forEach(ch => {
          if (ch.type === "removed") return;
          if (ch.doc.metadata.hasPendingWrites) return;   // এই ফোনের নিজের, এখনো সার্ভারে পৌঁছায়নি
          docs.push(ch.doc.data());
        });
        if (!docs.length) return;
        __enqueue(async () => {
          if (gen !== __watchGen) return;
          const changed = await __applyRemote(shopId, docs);
          if (changed && typeof onRemoteChange === "function") onRemoteChange({});
        }).catch((e) => console.error("Remote pull failed:", e));
      }, (err) => {
        console.error("ledger realtime listener error:", err);
      });
  });
}

function stopWatchingAppDataChanges() {
  __watchGen++;
  if (__appDataUnsubscribe) {
    __appDataUnsubscribe();
    __appDataUnsubscribe = null;
  }
}

function setSyncIndicator(state) {
  const el = document.getElementById("cloudSyncDot");
  if (!el) return;
  el.style.background = state === "ok" ? "#27633f" : state === "error" ? "#a3372c" : "#c9a96a";
  el.title = state === "ok" ? "সার্ভারের সাথে সিঙ্ক করা আছে" : state === "error" ? "সিঙ্ক ব্যর্থ — ইন্টারনেট চেক করুন" : "সিঙ্ক হচ্ছে...";
}

/* নিরাপত্তা স্তর: অ্যাপ মিনিমাইজ/ব্যাকগ্রাউন্ডে চলে গেলে (হোম বাটন চাপা, অন্য অ্যাপে
   যাওয়া, স্ক্রিন বন্ধ করা ইত্যাদি) সাথে সাথেই বাকি থাকা ডেটা সার্ভারে পাঠানোর চেষ্টা
   হয় — স্বাভাবিক ২.৫ সেকেন্ডের অপেক্ষা (debounce) এর জন্য বসে থাকে না। এতে সেল করার
   পরপরই অ্যাপ থেকে বের হয়ে গেলেও ডেটা হারানোর ঝুঁকি অনেক কমে যায়। */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && __syncShopId) {
    pushLocalStorageToCloud().catch(()=>{});
  }
});
