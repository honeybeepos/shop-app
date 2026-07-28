/* ============================================================
   service-worker.js
   অ্যাপের "শেল" (HTML/JS/ফন্ট) ক্যাশ করে রাখে, যাতে ইন্টারনেট
   না থাকলেও অ্যাপ খোলা যায় এবং সেল/এন্ট্রি করা যায়।
   ডেটা সিঙ্কের কাজ এটা করে না — সেটা Firestore SDK নিজেই
   অফলাইন-কিউ দিয়ে সামলায় (firebase-init.js এ enablePersistence)।
   ============================================================ */

const CACHE_VERSION = "shop-app-v1";

const APP_SHELL = [
  "login.html",
  "admin.html",
  "shop-ledger-app.html",
  "firebase-init.js",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { mode: url.startsWith("http") ? "no-cors" : "same-origin" })
            .then((res) => cache.put(url, res))
            .catch(() => {}) // একটা ফাইল ফেইল করলেও বাকিগুলো ক্যাশ হবে
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Firestore/Auth-এর নিজস্ব নেটওয়ার্ক কল (googleapis.com, firestore.googleapis.com ইত্যাদি)
// এই সার্ভিস ওয়ার্কার স্পর্শ করে না — Firestore SDK নিজেই সেগুলো অফলাইনে সামলায়।
self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (url.includes("firestore.googleapis.com") || url.includes("googleapis.com/identitytoolkit")) {
    return; // নেটওয়ার্কেই যেতে দাও, Firestore SDK নিজে ক্যাশ/রিট্রাই সামলাবে
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached); // অফলাইনে নেটওয়ার্ক ফেইল করলে ক্যাশ থেকে দাও

      // stale-while-revalidate: ক্যাশ থাকলে সাথে সাথে সেটা দেখাও (দ্রুত + অফলাইনে কাজ করে),
      // পাশাপাশি নেটওয়ার্ক থেকে আপডেট আনার চেষ্টা চলতে থাকে পরের বারের জন্য
      return cached || networkFetch;
    })
  );
});
