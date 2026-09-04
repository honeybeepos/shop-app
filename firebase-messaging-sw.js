/* ============================================================
   firebase-messaging-sw.js
   এই ফাইলটা delivery-man-app.html এর ঠিক পাশে (একই ফোল্ডারে, রুটে)
   রাখতে হবে — নাম অবিকল "firebase-messaging-sw.js" রাখা জরুরি।
   এই সার্ভিস ওয়ার্কার ব্রাউজার/অ্যাপ বন্ধ বা ব্যাকগ্রাউন্ডে থাকলেও
   পুশ নোটিফিকেশন রিসিভ করে দেখানোর কাজ করে।
   ============================================================ */

importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD6qmuWkNUrskMIBHq8Z_AQ0N_WT1DL8Is",
  authDomain: "honeybee-984dd.firebaseapp.com",
  projectId: "honeybee-984dd",
  storageBucket: "honeybee-984dd.firebasestorage.app",
  messagingSenderId: "610211112501",
  appId: "1:610211112501:web:9ea40b9060d425e85b737c"
});

const messaging = firebase.messaging();

// অ্যাপ ব্যাকগ্রাউন্ডে/বন্ধ থাকা অবস্থায় পুশ আসলে এখানে হ্যান্ডেল হয়
messaging.onBackgroundMessage((payload) => {
  const type = (payload.data && payload.data.type) || "delivery-offer";
  const title = (payload.notification && payload.notification.title) || "🔔 দোকান থেকে ডাকছে!";
  const body = (payload.notification && payload.notification.body) || "নতুন ডেলিভারি অর্ডার আছে — দোকানে যোগাযোগ করুন।";

  // 🏷️ tag আলাদা রাখা হয় টাইপ+আইডি দিয়ে — নাহলে একজন ইউজারের কাছে
  // একের-পর-এক ভিন্ন নোটিফিকেশন (যেমন দুটো ভিন্ন চ্যাটের মেসেজ) এলে
  // ব্রাউজার আগেরটাকে নতুনটা দিয়ে চুপচাপ replace করে ফেলত, ইউজার
  // প্রথমটা মিস করে যেতেন
  const tagId = (payload.data && (payload.data.chatId || payload.data.offerId || payload.data.orderId)) || "general";
  const tag = `honeybee-${type}-${tagId}`;

  self.registration.showNotification(title, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [500, 200, 500, 200, 500],
    requireInteraction: type !== "messenger-message", // মেসেজ-নোটিফিকেশন নিজে থেকেই কিছুক্ষণ পর সরে যাক, ডেলিভারি-কল জরুরি বলে থেকে যাবে
    tag,
    renotify: true,
    data: payload.data || {}
  });
});

// নোটিফিকেশনে ট্যাপ করলে অ্যাপ খুলে যাবে — কোন অ্যাপে যাবে তা নোটিফিকেশনের
// টাইপ অনুযায়ী ঠিক হয় (মেসেঞ্জার হলে Bazar, ডেলিভারি হলে Rider Mode)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const type = (event.notification.data && event.notification.data.type) || "delivery-offer";
  const targetFile = type === "messenger-message" ? "honey-bee-bazar.html" : "shop-ledger-app.html";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // ⚠️ delivery-man-app.html এখন আর আলাদা অ্যাপ না — Rider Mode হিসেবে
      // shop-ledger-app.html-এ একীভূত, তাই ফোকাস/ওপেন দুটোই সেদিকেই যাবে।
      // (পুরনো shop-code দিয়ে কানেক্ট করা কিছু ডিভাইস এখনো
      // delivery-man-app.html-এই থাকতে পারে — সেগুলোর জন্য নিচের প্রথম
      // চেকটা রাখা হলো, তবে নতুন সব রাইডারই shop-ledger-app.html ব্যবহার করেন)
      for (const client of clientList) {
        if ((client.url.includes(targetFile) || (targetFile === "shop-ledger-app.html" && client.url.includes("delivery-man-app.html"))) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetFile);
      }
    })
  );
});
