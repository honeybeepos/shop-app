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
   localStorage  <->  Firestore  সিঙ্ক ইঞ্জিন
   (মূল অ্যাপের ৬০০০+ লাইন কোড অপরিবর্তিত রেখে, এই লেয়ারটা
   লোকালস্টোরেজকে সার্ভারের সাথে সিঙ্ক করে রাখে)

   ⚠️ একাধিক ডিভাইস/সাব-ইউজার একইসাথে অফলাইনে সেল করতে পারে — তাই এখানে
   পুরো localStorage-কে একটা ব্লব হিসেবে ওভাররাইট করা হয় না। প্রতিটা কী
   (যেমন phone-shop-entries, bcc-products) আলাদাভাবে merge হয়:
   - যেসব কী array-of-records (id সহ) — সেগুলোতে দুই ডিভাইসের নতুন
     রেকর্ড কখনোই একে অপরকে মুছে দেয় না, id দিয়ে union করা হয়।
   - একই id দুই ডিভাইসেই আলাদাভাবে বদলে গেলে (সত্যিকারের conflict),
     যেই ডিভাইস সেই key-টা সর্বশেষ বদলেছে তার ভার্সন রাখা হয়।
   - shop-invoice-counter সবসময় বড় সংখ্যাটা রাখে, যাতে ইনভয়েস নাম্বার
     কখনো রিপিট না হয়।
   ============================================================ */

let __syncShopId = null;
let __syncTimer = null;
const SYNC_DEBOUNCE_MS = 2500;
const SESSION_KEY = "bcc-session";
const SYNC_META_KEY = "__syncMeta"; // প্রতিটা key শেষ কখন লোকালি বদলেছে, তার টাইমস্ট্যাম্প

// আসল localStorage ফাংশনগুলো ব্যাকআপ রাখা
const __origSetItem = Storage.prototype.setItem;
const __origGetItem = Storage.prototype.getItem;
const __origRemoveItem = Storage.prototype.removeItem;
const __origClear = Storage.prototype.clear;

// যেসব key একটা array-of-records রাখে, সেগুলো id মিলিয়ে merge হবে (whole-blob
// ওভাররাইটের বদলে) — যাতে দুই ডিভাইসের নতুন এন্ট্রি একে অপরকে মুছে না দেয়।
const ARRAY_MERGE_CONFIG = {
  "phone-shop-entries": { idFn: e => e.id },
  "bcc-products":       { idFn: p => p.id },
  "shop-expenses":      { idFn: x => x.id },
  "shop-supplier-txns": { idFn: x => x.id },
  "shop-employee-txns": { idFn: x => x.id },
  "shop-suppliers":     { idFn: x => x.id },
  "shop-employees":     { idFn: x => x.id },
  "bcc-extra-income":   { idFn: x => x.id },
  "bcc-due-log":        { idFn: x => (x.date || "") + "|" + (x.name || "") + "|" + (x.amount || "") },
  "phone-shop-customers": { idFn: c => (c.name || "").toLowerCase() + "|" + (c.phone || "") },
  // ক্যাটাগরি একটু আলাদা — এর ভেতরে subs[] নেস্টেড অ্যারে, সেটাও id মিলিয়ে merge হবে
  "bcc-categories":     { idFn: c => c.id, subKey: "subs", subIdFn: s => s.id }
};

// এই key-গুলোর মান সংখ্যা — merge-এর সময় সবসময় বড়টা রাখা হবে (যাতে
// ইনভয়েস নাম্বার কখনো ডুপ্লিকেট/রিপিট না হয়)
const NUMERIC_MAX_KEYS = ["shop-invoice-counter"];

function getSyncMeta() {
  try { return JSON.parse(__origGetItem.call(localStorage, SYNC_META_KEY) || "{}"); }
  catch (e) { return {}; }
}
function touchSyncMeta(key) {
  const meta = getSyncMeta();
  meta[key] = Date.now();
  __origSetItem.call(localStorage, SYNC_META_KEY, JSON.stringify(meta));
}

function enableAutoSync(shopId) {
  __syncShopId = shopId;

  Storage.prototype.setItem = function (key, value) {
    __origSetItem.call(this, key, value);
    if (this === window.localStorage) {
      if (key !== SESSION_KEY && key !== SYNC_META_KEY) touchSyncMeta(key);
      scheduleCloudSync();
    }
  };
  Storage.prototype.removeItem = function (key) {
    __origRemoveItem.call(this, key);
    if (this === window.localStorage) {
      if (key !== SESSION_KEY && key !== SYNC_META_KEY) touchSyncMeta(key);
      scheduleCloudSync();
    }
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
  stopWatchingAppDataChanges();
}

function scheduleCloudSync() {
  if (!__syncShopId) return;
  if (__syncTimer) clearTimeout(__syncTimer);
  __syncTimer = setTimeout(()=> pushLocalStorageToCloud().catch(()=>{}), SYNC_DEBOUNCE_MS);
}

// একই id দুই ডিভাইসেই থাকলে (সত্যিকারের conflict) — subKey (যেমন ক্যাটাগরির
// subs) থাকলে সেটাও আলাদাভাবে id মিলিয়ে merge করে, বাকিটা key-লেভেল
// টাইমস্ট্যাম্প দিয়ে সিদ্ধান্ত নেয় কোন ডিভাইসের ভার্সন রাখা হবে।
function mergeArraysById(localArr, remoteArr, localTs, remoteTs, cfg) {
  const idFn = cfg.idFn;
  const map = new Map();
  remoteArr.forEach(item => map.set(idFn(item), item));
  localArr.forEach(item => {
    const key = idFn(item);
    if (!map.has(key)) { map.set(key, item); return; } // নতুন লোকাল রেকর্ড — এটা কখনো হারাবে না
    const remoteItem = map.get(key);
    if (JSON.stringify(remoteItem) === JSON.stringify(item)) return; // দুই দিকেই একই, কিছু করার নেই
    let winner = (localTs >= remoteTs) ? item : remoteItem;
    if (cfg.subKey && Array.isArray(item[cfg.subKey]) && Array.isArray(remoteItem[cfg.subKey])) {
      winner = Object.assign({}, winner);
      winner[cfg.subKey] = mergeArraysById(item[cfg.subKey], remoteItem[cfg.subKey], localTs, remoteTs, { idFn: cfg.subIdFn });
    }
    map.set(key, winner);
  });
  return Array.from(map.values());
}

function mergeKeyValue(key, localVal, localTs, remoteVal, remoteTs) {
  if (localVal == null) return remoteVal;
  if (remoteVal == null) return localVal;
  if (localVal === remoteVal) return localVal;

  if (NUMERIC_MAX_KEYS.indexOf(key) !== -1) {
    return String(Math.max(Number(localVal) || 0, Number(remoteVal) || 0));
  }

  if (ARRAY_MERGE_CONFIG[key]) {
    try {
      const localArr = JSON.parse(localVal);
      const remoteArr = JSON.parse(remoteVal);
      if (Array.isArray(localArr) && Array.isArray(remoteArr)) {
        return JSON.stringify(mergeArraysById(localArr, remoteArr, localTs, remoteTs, ARRAY_MERGE_CONFIG[key]));
      }
    } catch (e) { /* পার্স না হলে নিচের last-write-wins ফলব্যাকে যাবে */ }
  }

  // সাধারণ সেটিংস (shop-title, bcc-password ইত্যাদি) — যেই ডিভাইস সবশেষে বদলেছে সেটাই থাকবে
  return remoteTs >= localTs ? remoteVal : localVal;
}

async function pushLocalStorageToCloud() {
  if (!__syncShopId) return;
  try {
    // প্রথমে সার্ভারের বর্তমান অবস্থাটা টেনে এনে লোকালের সাথে merge করা হয়, যাতে
    // এই ডিভাইস অফলাইনে থাকার সময় অন্য কোনো ডিভাইস যা যোগ করেছে সেটা হারিয়ে না যায়
    const snap = await db.collection("shops").doc(__syncShopId)
      .collection("appdata").doc("main").get();
    const remoteBlob = (snap.exists && snap.data().blob) ? JSON.parse(snap.data().blob) : {};
    const meta = getSyncMeta();

    const localKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === SESSION_KEY || k === SYNC_META_KEY) continue;
      localKeys.push(k);
    }
    const allKeys = new Set([...Object.keys(remoteBlob), ...localKeys]);

    const mergedBlob = {};
    allKeys.forEach(key => {
      const remoteEntry = remoteBlob[key];
      const remoteVal = remoteEntry && typeof remoteEntry === "object" ? remoteEntry.v : remoteEntry;
      const remoteTs   = remoteEntry && typeof remoteEntry === "object" ? (remoteEntry.t || 0) : 0;
      const localVal = __origGetItem.call(localStorage, key);
      const localTs  = meta[key] || 0;
      const mergedVal = mergeKeyValue(key, localVal, localTs, remoteVal, remoteTs);
      if (mergedVal != null) mergedBlob[key] = { v: mergedVal, t: Math.max(localTs, remoteTs) };
    });

    // merge হওয়া ফলাফলটা এই ডিভাইসের নিজের localStorage-এও বসিয়ে দেওয়া হয়, যাতে
    // এই ডিভাইসও অন্য ডিভাইসের সংযোজন সাথে সাথে দেখতে পায়
    const savedSession = __origGetItem.call(localStorage, SESSION_KEY);
    Object.keys(mergedBlob).forEach(k => __origSetItem.call(localStorage, k, mergedBlob[k].v));
    if (savedSession) __origSetItem.call(localStorage, SESSION_KEY, savedSession);

    await db.collection("shops").doc(__syncShopId)
      .collection("appdata").doc("main")
      .set({ blob: JSON.stringify(mergedBlob), updatedAt: fbNow(), updatedBy: __deviceId }, { merge: true });
    setSyncIndicator("ok");
  } catch (e) {
    console.error("Cloud sync failed:", e);
    setSyncIndicator("error");
    throw e; // await করা কলার (যেমন সেভ-কনফার্মেশন ইন্ডিকেটর) যেন ব্যর্থতা বুঝতে পারে
  }
}

async function pullCloudToLocalStorage(shopId) {
  const snap = await db.collection("shops").doc(shopId)
    .collection("appdata").doc("main").get();
  if (!snap.exists || !snap.data().blob) return false;
  const remoteBlob = JSON.parse(snap.data().blob);
  const meta = getSyncMeta();

  const localKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === SESSION_KEY || k === SYNC_META_KEY) continue;
    localKeys.push(k);
  }
  const allKeys = new Set([...Object.keys(remoteBlob), ...localKeys]);

  const mergedBlob = {};
  allKeys.forEach(key => {
    const remoteEntry = remoteBlob[key];
    const remoteVal = remoteEntry && typeof remoteEntry === "object" ? remoteEntry.v : remoteEntry;
    const remoteTs   = remoteEntry && typeof remoteEntry === "object" ? (remoteEntry.t || 0) : 0;
    const localVal = __origGetItem.call(localStorage, key);
    const localTs  = meta[key] || 0;
    mergedBlob[key] = mergeKeyValue(key, localVal, localTs, remoteVal, remoteTs);
  });

  // bcc-session এখন localStorage-এ থাকে (মিনিমাইজ করলে যেন লগইন না হারায়), কিন্তু নিচের
  // clear() পুরো localStorage মুছে দেয় — তাই সাময়িক ব্যাকআপ রেখে পরে আবার বসানো হচ্ছে
  const savedSession = __origGetItem.call(localStorage, SESSION_KEY);
  __origClear.call(localStorage);
  Object.keys(mergedBlob).forEach(k => { if (mergedBlob[k] != null) __origSetItem.call(localStorage, k, mergedBlob[k]); });
  if (savedSession) __origSetItem.call(localStorage, SESSION_KEY, savedSession);
  return true;
}

/* ============================================================
   রিয়েলটাইম "ওয়ার্কার" — সাব-ইউজার ডেটা পাঠালে এডমিন অটোমেটিক পাবে
   ============================================================
   এটা মিলিসেকেন্ড ধরে বার বার সার্ভার চেক (polling) করে না — তার বদলে Firestore-এর
   নিজস্ব onSnapshot ব্যবহার করে, যেটা সার্ভারের সাথে একটা লাইভ কানেকশন খুলে রাখে।
   শপের appdata/main ডকুমেন্টে যেই মুহূর্তে কেউ (সাব-ইউজার/এডমিন, যেকোনো ডিভাইস থেকে)
   পরিবর্তন করে, এই ফাংশনটা সাথে সাথেই (সাধারণত < ১ সেকেন্ডে) নোটিফাই পায়, নিজে থেকেই
   নতুন ডেটা টেনে এনে localStorage আপডেট করে দেয় — কোনো ম্যানুয়াল রিফ্রেশ/রিলগইন লাগে না। */
let __appDataUnsubscribe = null;

function watchAppDataChanges(shopId, onRemoteChange) {
  stopWatchingAppDataChanges(); // আগে চালু কোনো লিসেনার থাকলে বন্ধ করে নতুন করে বসানো

  __appDataUnsubscribe = db.collection("shops").doc(shopId)
    .collection("appdata").doc("main")
    .onSnapshot((snap) => {
      if (!snap.exists) return;

      // এই ডিভাইস নিজে যে পরিবর্তনটা করেছে কিন্তু এখনো সার্ভার কনফার্ম করেনি —
      // সেটার জন্য সাথে সাথে একটা লোকাল ইকো আসে, ওটা স্কিপ করে দাও
      if (snap.metadata.hasPendingWrites) return;

      const data = snap.data();
      if (!data) return;

      // এটা যদি এই ডিভাইস নিজেই পাঠানো সর্বশেষ পরিবর্তন হয়, তাহলে আবার
      // টেনে এনে UI রিফ্রেশ করার দরকার নেই (নিজের ডেটা নিজের কাছেই আছে)
      if (data.updatedBy === __deviceId) return;

      // অন্য কোনো ডিভাইস (যেমন সাব-ইউজার) নতুন কিছু পাঠিয়েছে — টেনে আনো
      pullCloudToLocalStorage(shopId).then((ok) => {
        if (ok && typeof onRemoteChange === "function") onRemoteChange(data);
      }).catch((e) => console.error("Remote pull failed:", e));
    }, (err) => {
      console.error("appdata realtime listener error:", err);
    });
}

function stopWatchingAppDataChanges() {
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
