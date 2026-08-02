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
   ============================================================ */

let __syncShopId = null;
let __syncTimer = null;
const SYNC_DEBOUNCE_MS = 2500;

// আসল localStorage ফাংশনগুলো ব্যাকআপ রাখা
const __origSetItem = Storage.prototype.setItem;
const __origGetItem = Storage.prototype.getItem;
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
  stopWatchingAppDataChanges();
}

function scheduleCloudSync() {
  if (!__syncShopId) return;
  if (__syncTimer) clearTimeout(__syncTimer);
  __syncTimer = setTimeout(()=> pushLocalStorageToCloud().catch(()=>{}), SYNC_DEBOUNCE_MS);
}

function safeParseArray(str) {
  if (!str) return [];
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

/* দুটো লিস্ট (যেমন প্রোডাক্ট বা ক্যাটাগরি) তাদের id দিয়ে "মার্জ" (মিলিয়ে) করে —
   কোনোটাই ওভাররাইট/মুছে যায় না, শুধু conflict হলে overlayArr-এর ভার্সনটা রাখা হয়।
   এটাই মূল সমাধান "অফলাইনে যোগ করা প্রোডাক্ট হারিয়ে যাওয়া" সমস্যার — আগে পুরো
   লিস্টটাই একপাশ থেকে আরেকপাশে ওভাররাইট হয়ে যেত, তাই অন্য ডিভাইসের ডেটা সিঙ্ক
   হওয়ার সময় এই ডিভাইসে অফলাইনে যোগ করা (এখনো push না হওয়া) প্রোডাক্ট মুছে যেত। */
function mergeArraysById(baseArr, overlayArr) {
  const map = new Map();
  (baseArr || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  (overlayArr || []).forEach(item => { if (item && item.id != null) map.set(item.id, item); });
  return Array.from(map.values());
}

async function pushLocalStorageToCloud() {
  if (!__syncShopId) return;
  const blob = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === "bcc-session") continue; // এটা এই ডিভাইসের লগইন সেশন, দোকানের ডেটা না — সিঙ্ক হবে না
    blob[k] = localStorage.getItem(k);
  }

  /* Admin/যেকোনো ডিভাইস কিছু ডিলিট করলে সেই ডিলিট যেন কখনো "ফিরে" না আসে —
     এই কারণে push করার আগে ক্লাউডে বর্তমানে কী আছে সেটা একবার দেখে নেওয়া হয়।
     ডিলিট-লিস্ট (tombstone) সবসময় স্থানীয় + ক্লাউড দুটোর "ইউনিয়ন" রাখা হয় (কখনো
     ছোট/হারিয়ে যায় না), এবং সেই মার্জ করা লিস্ট দিয়ে এন্ট্রি/কাস্টমার লিস্ট থেকেও
     ডিলিট হওয়া জিনিস বাদ দেওয়া হয়। প্রোডাক্ট/ক্যাটাগরিও একই কারণে id দিয়ে মার্জ
     করা হয় (এখানে লোকাল ভার্সন প্রায়োরিটি পায়, যেহেতু এটা এই ডিভাইসের সাম্প্রতিক
     পরিবর্তন) — যাতে অফলাইনে যোগ করা প্রোডাক্ট অন্য ডিভাইসের ডেটার কারণে হারিয়ে না যায়।

     গুরুত্বপূর্ণ: এই ধাপটা (আগে থেকে ক্লাউড ডেটা পড়া) যদি কোনো কারণে ব্যর্থ হয়
     (যেমন পারমিশন সমস্যা — সাব-ইউজারের জন্য এই কালেকশনে read এক্সেস না থাকতে
     পারে, বা সাময়িক নেটওয়ার্ক সমস্যা), তাহলেও যেন আসল push (নিচের set কল)
     আটকে না যায় — তাই এটা একদম আলাদা try/catch-এ রাখা হলো এবং ব্যর্থ হলে
     শুধু মার্জ স্কিপ করে সরাসরি push চালিয়ে যাওয়া হয়। */
  try {
    const cloudSnap = await db.collection("shops").doc(__syncShopId)
      .collection("appdata").doc("main").get();
    const cloudBlob = (cloudSnap.exists && cloudSnap.data().blob) ? JSON.parse(cloudSnap.data().blob) : null;

    if (cloudBlob) {
      const localDelEntries = safeParseArray(blob["phone-shop-deleted-entry-ids"]);
      const cloudDelEntries = safeParseArray(cloudBlob["phone-shop-deleted-entry-ids"]);
      const mergedDelEntries = Array.from(new Set([...localDelEntries, ...cloudDelEntries]));

      const localDelCust = safeParseArray(blob["phone-shop-deleted-customer-keys"]);
      const cloudDelCust = safeParseArray(cloudBlob["phone-shop-deleted-customer-keys"]);
      const mergedDelCust = Array.from(new Set([...localDelCust, ...cloudDelCust]));

      if (mergedDelEntries.length) blob["phone-shop-deleted-entry-ids"] = JSON.stringify(mergedDelEntries);
      if (mergedDelCust.length) blob["phone-shop-deleted-customer-keys"] = JSON.stringify(mergedDelCust);

      if (mergedDelEntries.length || mergedDelCust.length) {
        const custKey = (name, phone) => (phone || "") + "|" + (name || "");
        let entries = safeParseArray(blob["phone-shop-entries"]);
        if (entries.length) {
          entries = entries.filter(e => !mergedDelEntries.includes(e.id) && !mergedDelCust.includes(custKey(e.name, e.phone)));
          blob["phone-shop-entries"] = JSON.stringify(entries);
        }
        let customers = safeParseArray(blob["phone-shop-customers"]);
        if (customers.length) {
          customers = customers.filter(c => !mergedDelCust.includes(custKey(c.name, c.phone)));
          blob["phone-shop-customers"] = JSON.stringify(customers);
        }
      }

      // প্রোডাক্ট ও ক্যাটাগরি: cloud + local দুটো মিলিয়ে (local প্রায়োরিটি পেয়ে) রাখা হচ্ছে
      const mergedProducts = mergeArraysById(safeParseArray(cloudBlob["bcc-products"]), safeParseArray(blob["bcc-products"]));
      blob["bcc-products"] = JSON.stringify(mergedProducts);
      const mergedCategories = mergeArraysById(safeParseArray(cloudBlob["bcc-categories"]), safeParseArray(blob["bcc-categories"]));
      blob["bcc-categories"] = JSON.stringify(mergedCategories);

      // এই ডিভাইসের নিজের localStorage-ও ঠিক করে দেওয়া হচ্ছে, যাতে এটা নিজেও
      // বারবার পুরনো/স্টেল ডেটা push করতে না থাকে (সিঙ্ক লুপ এড়াতে মূল
      // setItem override ব্যবহার না করে সরাসরি লেখা হচ্ছে)
      if (blob["phone-shop-deleted-entry-ids"]) __origSetItem.call(localStorage, "phone-shop-deleted-entry-ids", blob["phone-shop-deleted-entry-ids"]);
      if (blob["phone-shop-deleted-customer-keys"]) __origSetItem.call(localStorage, "phone-shop-deleted-customer-keys", blob["phone-shop-deleted-customer-keys"]);
      if (blob["phone-shop-entries"]) __origSetItem.call(localStorage, "phone-shop-entries", blob["phone-shop-entries"]);
      if (blob["phone-shop-customers"]) __origSetItem.call(localStorage, "phone-shop-customers", blob["phone-shop-customers"]);
      __origSetItem.call(localStorage, "bcc-products", blob["bcc-products"]);
      __origSetItem.call(localStorage, "bcc-categories", blob["bcc-categories"]);
    }
  } catch (mergeErr) {
    console.warn("ডেটা মার্জ করা যায়নি, সরাসরি push করা হচ্ছে:", mergeErr);
  }

  try {
    await db.collection("shops").doc(__syncShopId)
      .collection("appdata").doc("main")
      .set({ blob: JSON.stringify(blob), updatedAt: fbNow(), updatedBy: __deviceId }, { merge: true });
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
  const blob = JSON.parse(snap.data().blob);

  // প্রোডাক্ট/ক্যাটাগরি পুরোপুরি ওভাররাইট না করে cloud + বর্তমান local মিলিয়ে
  // (cloud প্রায়োরিটি পেয়ে, কিন্তু local-এ থাকা এখনো push না হওয়া নতুন প্রোডাক্টও
  // রেখে) রাখা হচ্ছে — এতে অফলাইনে যোগ করা প্রোডাক্ট pull করার সময় হারিয়ে যায় না।
  try {
    const localProducts = safeParseArray(__origGetItem.call(localStorage, "bcc-products"));
    const cloudProducts = safeParseArray(blob["bcc-products"]);
    blob["bcc-products"] = JSON.stringify(mergeArraysById(localProducts, cloudProducts));

    const localCategories = safeParseArray(__origGetItem.call(localStorage, "bcc-categories"));
    const cloudCategories = safeParseArray(blob["bcc-categories"]);
    blob["bcc-categories"] = JSON.stringify(mergeArraysById(localCategories, cloudCategories));
  } catch (mergeErr) {
    console.warn("প্রোডাক্ট/ক্যাটাগরি মার্জ করা যায়নি, cloud ভার্সন দিয়েই বসানো হচ্ছে:", mergeErr);
  }

  // bcc-session এখন localStorage-এ থাকে (মিনিমাইজ করলে যেন লগইন না হারায়), কিন্তু নিচের
  // clear() পুরো localStorage মুছে দেয় — তাই সাময়িক ব্যাকআপ রেখে পরে আবার বসানো হচ্ছে
  const savedSession = __origGetItem.call(localStorage, "bcc-session");
  __origClear.call(localStorage);
  Object.keys(blob).forEach(k => __origSetItem.call(localStorage, k, blob[k]));
  if (savedSession) __origSetItem.call(localStorage, "bcc-session", savedSession);
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
