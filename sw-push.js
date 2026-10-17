/* ============================================================
   sw-push.js — 🔔 পুশ নোটিফিকেশনের আসল কাজ (অক্টোবর ২০২৬)
   ⚠️ কেন আলাদা ফাইল: সাইটে দুইটা সার্ভিস ওয়ার্কার ফাইল ছিল —
      service-worker.js (অফলাইন ক্যাশ) আর firebase-messaging-sw.js (পুশ)।
      দুইটাই সাইটের গোড়ায় (একই scope), আর ব্রাউজার এক scope-এ একটাই
      রাখে। login.html/POS খুললে service-worker.js বসে যেত আর পুশের
      ফাইলটা সরে যেত — তখন অ্যাপ বন্ধ থাকলে নোটিফিকেশন আর আসত না
      (খোলা অবস্থায় আসত, তাই ধরা পড়ত না)। এখন দুইটা ফাইলই এই একই
      পুশ-কোড টেনে নেয়, তাই যেটাই বসুক — পুশ চলবে।
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
  // 🔁 "notification" অংশসহ পুশ Firebase নিজেই ফোনের উপরে দেখায় — এখানে আবার
  //    দেখালে একই খবর দুইবার আসত। তাই শুধু data-পুশ (title/body data-তে) এখানে দেখানো হয়।
  if (payload && payload.notification) return;
  const type = (payload.data && payload.data.type) || "delivery-offer";
  const title = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || "🔔 দোকান থেকে ডাকছে!";
  const body = (payload.notification && payload.notification.body) || (payload.data && payload.data.body) || "নতুন ডেলিভারি অর্ডার আছে — দোকানে যোগাযোগ করুন।";
  // 🎫 চালকের কাছে নতুন বুকিং — নোটিফিকেশনেই "গ্রহণ / বাতিল" বোতাম
  const actions = (type === "tm-booking-driver" && payload.data && payload.data.actions === "1")
    ? [{ action: "accept", title: "✅ গ্রহণ করুন" }, { action: "decline", title: "❌ বাতিল করুন" }] : undefined;

  // 🏷️ tag আলাদা রাখা হয় টাইপ+আইডি দিয়ে — নাহলে একজন ইউজারের কাছে
  // একের-পর-এক ভিন্ন নোটিফিকেশন (যেমন দুটো ভিন্ন চ্যাটের মেসেজ) এলে
  // ব্রাউজার আগেরটাকে নতুনটা দিয়ে চুপচাপ replace করে ফেলত, ইউজার
  // প্রথমটা মিস করে যেতেন
  // 📢 Honey Bee Transport Media Phase 7 — tripId/postId-ও tagId হিসেবে ব্যবহার হয়
  // 🔔 পঞ্জিকা রিমাইন্ডারে dateKey (যেদিনের তিথির কথা বলা হচ্ছে) tagId হিসেবে
  // যায়, নাহলে পরপর কয়েক দিনের রিমাইন্ডার একটা আরেকটাকে replace করে ফেলত
  const tagId = (payload.data && (payload.data.chatId || payload.data.offerId || payload.data.orderId || payload.data.tripId || payload.data.postId || payload.data.bookingId || payload.data.dateKey)) || "general";
  // 🔔 অর্ডার-খবরের পুশ হাব নিজের tag পাঠায় (একই রসিদের খবর একটাই নোটিফিকেশনে থাকে)
  const tag = (payload.data && payload.data.tag) ? `honeybee-${payload.data.tag}` : `honeybee-${type}-${tagId}`;

  // 🔕 মেসেজ/মন্তব্যের মতো হালকা নোটিফিকেশন নিজে থেকেই কিছুক্ষণ পর সরে
  // যাক — শুধু ডেলিভারি-কল আর ট্রিপ-কনফার্মের মতো সরাসরি অ্যাকশন-দরকার
  // নোটিফিকেশন থেকেই যাবে যতক্ষণ না ব্যবহারকারী নিজে সরান
  // পঞ্জিকা রিমাইন্ডারও হালকা ধরনের — সাথে সাথে কিছু করার নেই, তাই নিজে থেকেই সরে যাবে
  const softTypes = ["messenger-message", "tm-comment", "panchang-reminder"];

  self.registration.showNotification(title, {
    body,
    icon: "icon-192.png",
    badge: "icon-192.png",
    vibrate: [500, 200, 500, 200, 500],
    requireInteraction: !softTypes.includes(type),
    tag,
    renotify: true,
    actions,
    data: payload.data || {}
  });
});

// নোটিফিকেশনে ট্যাপ করলে অ্যাপ খুলে যাবে — কোন অ্যাপে যাবে তা নোটিফিকেশনের
// টাইপ অনুযায়ী ঠিক হয় (মেসেঞ্জার হলে Bazar, ডেলিভারি হলে Rider Mode)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const type = (event.notification.data && event.notification.data.type) || "delivery-offer";
  // 🎫 Transport Media বুকিং — নোটিফিকেশনে নিজের ঠিকানা (link) থাকে:
  //    চালক → honey-bee-driver.html#bookings, যাত্রী → honey-bee-transport.html?page=bookings
  let link = event.notification.data && event.notification.data.link;
  // ✅/❌ বোতাম চাপলে চালকের অ্যাপ খুলে নিজে থেকেই গ্রহণ/বাতিল করবে
  const bid = event.notification.data && event.notification.data.bookingId;
  if (type === "tm-booking-driver" && bid && (event.action === "accept" || event.action === "decline")) {
    link = new URL("honey-bee-driver.html?bk=" + encodeURIComponent(bid) + "&act=" + event.action + "#bookings", self.registration.scope).href;
  }
  // 🔗 ঠিকানা (link) সহ নোটিফিকেশন — বুকিং, আর দোকান/রেস্টুরেন্ট/রাইডারের অর্ডার-খবর —
  //    সেই অ্যাপটাই খোলে। অ্যাপ আগে থেকে খোলা থাকলে: বুকিংয়ে পাতা বদলায়; দোকান/রাইডারে
  //    পাতা রিলোড না করে শুধু সামনে আনে (চলতি বিক্রির হিসাব যেন না হারায়) আর খবর পাঠায়
  const isBooking = type === "tm-booking-driver" || type === "tm-booking-passenger";
  if (link) {
    // যে অ্যাপের ঠিকানা (চালক → honey-bee-driver.html, যাত্রী → honey-bee-bazar.html), সেই উইন্ডো খোলা থাকলে সেটাতেই যায়
    let file = type === "tm-booking-driver" ? "honey-bee-driver.html" : "honey-bee-bazar.html";
    try { file = new URL(link, self.registration.scope).pathname.split("/").pop() || file; } catch (e) {}
    event.waitUntil(
      clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const c of list) {
          if (!c.url.includes(file)) continue;
          if (isBooking && "navigate" in c) return c.navigate(link).then((w) => w && w.focus());
          if (!isBooking && "focus" in c) {
            try { c.postMessage({ hbPushOpen: event.notification.data || {} }); } catch (e) {}
            return c.focus();
          }
        }
        return clients.openWindow ? clients.openWindow(link) : null;
      })
    );
    return;
  }
  // 📢 Honey Bee Transport Media Phase 7 — যাত্রী-মুখী পুশ (নতুন ভাড়া
  // অফার, ট্রিপ কনফার্ম) Bazar অ্যাপে যাবে; ড্রাইভার-মুখী পুশ (ট্রিপ
  // কনফার্ম, পোস্টে মন্তব্য) Rider/Driver Mode-এ (shop-ledger-app.html)
  // 🐞 বাগ-ফিক্স: অর্ডারের খবরগুলো (গ্রহণ করা হয়েছে, প্যাকেজিং শেষ,
  //    পথে আছে, পৌঁছে গেছে) যায় গ্রাহকের কাছে, কিন্তু এই তালিকায়
  //    ছিল না — তাই গ্রাহক নোটিফিকেশনে চাপ দিলে দোকানদারের POS খুলত,
  //    যেখানে তাঁর কিছুই নেই। এখন বাজারেই খুলবে।
  const passengerFacingTypes = ["messenger-message", "trip-offer", "trip-confirmed", "trip-chat-passenger", "flight-update", "panchang-reminder",
                                "order-accepted", "order-packaging-done", "order-status"];
  // 🍽️ রেস্টুরেন্টের নতুন অর্ডারের পুশ রেস্টুরেন্টের নিজের POS-এ খুলবে —
  //    নাহলে দোকানের POS খুলত, যেখানে রেস্টুরেন্ট মালিকের কিছুই নেই
  const restaurantFacingTypes = ["restaurant-order"];
  const targetFile = restaurantFacingTypes.includes(type) ? "restaurant-pos.html"
                   : passengerFacingTypes.includes(type) ? "honey-bee-bazar.html"
                   : "shop-ledger-app.html";

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
