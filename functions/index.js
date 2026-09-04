/* ============================================================
   functions/index.js
   এই ফাইলে এখন তিনটা সিস্টেম আছে:

   ১. পুরনো সিস্টেম (legacy): দোকান "ডেলিভারি ম্যান কে ডাকুন" চাপলে
      shops/{shopId}/deliveryDevices-এ রেজিস্টার্ড ডিভাইসে (পুরনো
      delivery-man-app.html, শপ-কোড দিয়ে কানেক্ট করা) পুশ নোটিফিকেশন
      পাঠানো হয়। যেসব দোকান এখনো Agent/Rider সিস্টেমে যুক্ত হয়নি,
      তাদের জন্য এটা এখনো কাজ করবে। — অপরিবর্তিত।

   ২. Honey Bee Delivery App (deliveryCalls-ভিত্তিক, পুরনো ম্যানুয়াল
      "ডেলিভারি ম্যান কে ডাকুন" কল থেকে) — Agent-নিবন্ধিত রাইডারদের
      মধ্যে সবচেয়ে কাছের অনলাইন রাইডারকে খুঁজে একটা "অফার"
      (deliveryOffers) তৈরি করা হয়। — অপরিবর্তিত (dispatchToNearestRider)।

   ৩. 🆕 Bazar Order Auto-Dispatch (orderRequests-ভিত্তিক) — Bazar-এর
      Cart-checkout থেকে আসা আসল কাস্টমার-অর্ডারের জন্য। দোকানদার
      "✅ গ্রহণ করুন" চাপলে (status: pending→preparing) স্বয়ংক্রিয়ভাবে
      Market-priority + Route-batching + Road-distance দিয়ে সবচেয়ে
      উপযুক্ত ডেলিভারি-ডিউটিতে-থাকা রাইডার খুঁজে অফার পাঠানো হয়,
      ৬০ সেকেন্ডে সাড়া না পেলে পরের জনকে। সিস্টেম ২-এর deliveryOffers
      কালেকশনই পুনর্ব্যবহার করা হয় (callId-এর বদলে orderId দিয়ে),
      দুটো সিস্টেম একই কালেকশনে সহাবস্থান করে কিন্তু একে অপরকে
      প্রভাবিত করে না (orderId vs callId দিয়ে আলাদা করা হয়)।

   ডিপ্লয় করতে হবে — চ্যাট থেকে এটা সরাসরি Firebase-এ বসানো যায় না।
   DEPLOY-README.md ফাইলে ধাপে ধাপে নির্দেশনা আছে।
   ============================================================ */

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage"); // 🖼️ Step 6 — orphan image cleanup-এর জন্য

initializeApp();
const db = getFirestore();

// 🌐 GitHub Pages-এর আসল ডোমেইন — আগে এখানে "YOUR-DOMAIN-HERE" প্লেসহোল্ডার
// ছিল, কখনো বসানো হয়নি। delivery-man-app.html এখন আর আলাদা অ্যাপ না
// (Rider Mode হিসেবে shop-ledger-app.html-এ একীভূত), তাই লিংকও সেভাবে ঠিক করা হলো।
const APP_DOMAIN = "https://honeybeebazar.com"; // ✅ কাস্টম ডোমেইন (CNAME ফাইলে নিশ্চিত করা) — GitHub-এর ডিফল্ট subdomain-এর বদলে
const RIDER_MODE_URL = `${APP_DOMAIN}/shop-ledger-app.html`;
const BAZAR_APP_URL = `${APP_DOMAIN}/honey-bee-bazar.html`; // 🔔 Honey Messenger নোটিফিকেশনে ট্যাপ করলে এখানে যাবে

// 🔑 Google Maps API key — এটা কোডে সরাসরি লেখা নেই, Firebase Secrets Manager-এ
// রাখা হয় (`firebase functions:secrets:set GOOGLE_MAPS_API_KEY`), তাই এটা
// কখনো GitHub রিপোতে (পাবলিক হলেও) প্রকাশ পায় না — শুধু সার্ভার-সাইড এই
// ফাংশনগুলোর ভেতরেই ব্যবহার হয়, ক্লায়েন্ট/HTML-এ কখনো পাঠানো হয় না।
const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");

// 🔑 Gemini API key — একই নীতিতে Secrets Manager-এ (কখনো কোডে/ক্লায়েন্টে না)।
// সেট করতে: firebase functions:secrets:set GEMINI_API_KEY
const geminiApiKey = defineSecret("GEMINI_API_KEY");

const OFFER_TIMEOUT_SECONDS = 60;
// রাইডার/এজেন্ট/হানি-বি — আয়ের ভাগ (Phase 5 ব্লুপ্রিন্ট অনুযায়ী: ৭০/২০/১০)
const RIDER_SHARE = 0.7;
// একজন রাইডারকে একসাথে সর্বোচ্চ কতগুলো চলমান (shipped) অর্ডার দেওয়া যাবে —
// Route Batching-এ "unlimited order assign করা যাবে না" শর্ত রক্ষা করতে
const MAX_CONCURRENT_ORDERS_PER_RIDER = 4;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 📏 Google Distance Matrix API দিয়ে আসল রোড-ডিস্ট্যান্স/সময় বের করা —
// প্রতিটা (origin, destination) জোড়া প্রায় ১০০ মিটার নির্ভুলতায় রাউন্ড করে
// Firestore-এ ২ ঘণ্টার জন্য ক্যাশ করা হয়। API কল ব্যর্থ হলে সরলরেখার
// (Haversine) দূরত্বে নিরাপদে ফলব্যাক করে।
async function getRoadDistanceKm(originLat, originLng, destLat, destLng) {
  const cacheKey = `${originLat.toFixed(3)}_${originLng.toFixed(3)}_${destLat.toFixed(3)}_${destLng.toFixed(3)}`;
  const cacheRef = db.collection("distanceCache").doc(cacheKey);
  const twoHoursAgoMs = Date.now() - 2 * 60 * 60 * 1000;

  try {
    const cacheDoc = await cacheRef.get();
    if (cacheDoc.exists) {
      const data = cacheDoc.data();
      if (data.cachedAt && data.cachedAt.toMillis() > twoHoursAgoMs) {
        return { distanceKm: data.distanceKm, durationMin: data.durationMin, source: "cache" };
      }
    }
  } catch (e) { /* ক্যাশ পড়তে না পারলেও সমস্যা নেই, নতুন করে চাইবে */ }

  const apiKey = googleMapsApiKey.value();
  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${originLat},${originLng}&destinations=${destLat},${destLng}&mode=driving&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      const element = data.rows && data.rows[0] && data.rows[0].elements && data.rows[0].elements[0];
      if (element && element.status === "OK") {
        const distanceKm = element.distance.value / 1000;
        const durationMin = element.duration.value / 60;
        await cacheRef.set({ distanceKm, durationMin, cachedAt: FieldValue.serverTimestamp() });
        return { distanceKm, durationMin, source: "google" };
      }
      console.warn("Distance Matrix এরর রেসপন্স:", JSON.stringify(data).slice(0, 300));
    } catch (e) {
      console.warn("Distance Matrix API কল ব্যর্থ হয়েছে:", e);
    }
  }

  return { distanceKm: haversineKm(originLat, originLng, destLat, destLng), durationMin: null, source: "haversine-fallback" };
}

async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
    const res = await fetch(url, { headers: { "User-Agent": "HoneyBeeDelivery/1.0" } });
    const data = await res.json();
    return data && data.display_name ? data.display_name : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch (e) {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

async function notifyLegacyDevices(shopId, shopName) {
  const devicesSnap = await db
    .collection("shops").doc(shopId)
    .collection("deliveryDevices")
    .where("active", "==", true)
    .get();

  if (devicesSnap.empty) return;

  const tokens = devicesSnap.docs.map((d) => d.id);
  const message = {
    notification: {
      title: `🔔 ${shopName} থেকে ডাকছে!`,
      body: "নতুন ডেলিভারি অর্ডার আছে — দোকানে যোগাযোগ করুন।",
    },
    data: { type: "delivery-call", shopId },
    webpush: {
      fcmOptions: { link: RIDER_MODE_URL },
    },
    tokens,
  };

  const response = await getMessaging().sendEachForMulticast(message);
  const deadTokens = [];
  response.responses.forEach((r, idx) => {
    if (!r.success && r.error && r.error.code === "messaging/registration-token-not-registered") {
      deadTokens.push(tokens[idx]);
    }
  });
  await Promise.all(
    deadTokens.map((t) =>
      db.collection("shops").doc(shopId).collection("deliveryDevices").doc(t).delete()
    )
  );
}

// 🔔 একজন নির্দিষ্ট রাইডারকে (riders/{riderId}.fcmToken থাকলে) পুশ
// নোটিফিকেশন পাঠানো — কাস্টমারের ফোন/ঠিকানার মতো স্পর্শকাতর তথ্য
// payload-এ পাঠানো হয় না, রাইডার অ্যাপ খুলে Accept করলেই বিস্তারিত দেখবেন
async function sendFcmToRider(riderId, title, body, data) {
  try {
    const riderDoc = await db.collection("riders").doc(riderId).get();
    const token = riderDoc.exists ? riderDoc.data().fcmToken : null;
    if (!token) return false;

    await getMessaging().send({
      token,
      notification: { title, body },
      data: Object.assign({ type: "delivery-offer" }, data || {}),
      webpush: { fcmOptions: { link: RIDER_MODE_URL } },
    });
    console.log(JSON.stringify({ event: "FCM_SENT", riderId }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ event: "FCM_FAILED", riderId, error: String(e && e.message || e) }));
    if (e && e.code === "messaging/registration-token-not-registered") {
      await db.collection("riders").doc(riderId).update({ fcmToken: FieldValue.delete() }).catch(() => {});
    }
    return false;
  }
}

/* ==================== 🔔 Honey Messenger — নতুন মেসেজের পুশ নোটিফিকেশন ====================
   ⚠️ sendFcmToRider()-এর থেকে ইচ্ছাকৃতভাবে সম্পূর্ণ আলাদা ফাংশন — যাতে
   এই নতুন কোডের কোনো বাগ কখনো বিদ্যমান Rider-নোটিফিকেশন সিস্টেমকে
   প্রভাবিত করতে না পারে। */
async function sendFcmToMessengerUser(uid, title, body, data) {
  try {
    const userDoc = await db.collection("messengerUsers").doc(uid).get();
    const token = userDoc.exists ? userDoc.data().fcmToken : null;
    if (!token) return false;

    await getMessaging().send({
      token,
      notification: { title, body },
      data: Object.assign({ type: "messenger-message" }, data || {}),
      webpush: { fcmOptions: { link: BAZAR_APP_URL } },
    });
    console.log(JSON.stringify({ event: "MESSENGER_FCM_SENT", uid }));
    return true;
  } catch (e) {
    console.warn(JSON.stringify({ event: "MESSENGER_FCM_FAILED", uid, error: String(e && e.message || e) }));
    if (e && e.code === "messaging/registration-token-not-registered") {
      await db.collection("messengerUsers").doc(uid).update({ fcmToken: FieldValue.delete() }).catch(() => {});
    }
    return false;
  }
}

// 🎯 নতুন মেসেজ তৈরি হলেই ট্রিগার — প্রাপককে (প্রেরক বাদে participants-এর
// বাকি সবাইকে) পুশ পাঠানো হয়। Privacy Mode চ্যাটে বার্তার কনটেন্ট
// notification-এ কখনো পাঠানো হয় না (শুধু "🔐 একটা মেসেজ") — ঠিক
// অ্যাপের নিজস্ব lastMessage-প্রদর্শনের নিয়মের সাথে মিলিয়ে।
exports.onMessengerMessageCreated = onDocumentCreated(
  "messengerChats/{chatId}/messages/{messageId}",
  async (event) => {
    const chatId = event.params.chatId;
    const messageData = event.data.data();
    const senderUid = messageData.senderUid;
    if (!senderUid) return;

    const chatDoc = await db.collection("messengerChats").doc(chatId).get();
    if (!chatDoc.exists) return;
    const chatData = chatDoc.data();
    const participants = chatData.participants || [];
    const recipientUid = participants.find((uid) => uid !== senderUid);
    if (!recipientUid) return;

    const senderDoc = await db.collection("messengerUsers").doc(senderUid).get();
    const senderName = (senderDoc.exists && (senderDoc.data().fullName || senderDoc.data().username)) || "কেউ একজন";

    const isPrivacy = chatData.mode === "privacy";
    const body = isPrivacy ? "🔐 একটা মেসেজ পাঠিয়েছেন" : (messageData.text || "").slice(0, 100);

    await sendFcmToMessengerUser(recipientUid, `💬 ${senderName}`, body, { chatId });
  }
);

async function dispatchToNearestRider(shopId, callId, callData, excludeRiderIds) {
  const shopDoc = await db.collection("shops").doc(shopId).get();
  const shopData = shopDoc.exists ? shopDoc.data() : {};
  const shopName = shopData.name || shopData.shopName || "দোকান";
  const storeLoc = shopData.storeLocation;

  if (!storeLoc || !callData.customerLocation) {
    console.log("দোকান বা কাস্টমারের লোকেশন নেই — geo-dispatch স্কিপ করা হচ্ছে");
    return null;
  }

  const ridersSnap = await db.collection("riders")
    .where("status", "==", "active")
    .where("online", "==", true)
    .get();

  let candidates = ridersSnap.docs
    .filter((d) => !excludeRiderIds.includes(d.id))
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.liveLocation && r.liveLocation.lat != null);

  if (candidates.length === 0) {
    console.log("কোনো অনলাইন রাইডার পাওয়া যায়নি");
    return null;
  }

  candidates.forEach((r) => {
    r.distanceKm = haversineKm(storeLoc.lat, storeLoc.lng, r.liveLocation.lat, r.liveLocation.lng);
  });
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = candidates[0];

  const roadDist = await getRoadDistanceKm(storeLoc.lat, storeLoc.lng, nearest.liveLocation.lat, nearest.liveLocation.lng);
  nearest.distanceKm = roadDist.distanceKm;

  const dropAddress = await reverseGeocode(callData.customerLocation.lat, callData.customerLocation.lng);
  const estimatedCharge = callData.estimatedCharge || 0;
  const riderIncome = Math.round(estimatedCharge * RIDER_SHARE * 100) / 100;

  const expiresAt = Timestamp.fromMillis(Date.now() + OFFER_TIMEOUT_SECONDS * 1000);

  const offerRef = await db.collection("deliveryOffers").add({
    shopId, callId,
    riderId: nearest.id,
    status: "pending",
    pickupName: shopName,
    pickupLat: storeLoc.lat, pickupLng: storeLoc.lng,
    dropLat: callData.customerLocation.lat, dropLng: callData.customerLocation.lng,
    dropAddress,
    distanceKm: Math.round(nearest.distanceKm * 10) / 10,
    estimatedCharge, riderIncome,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  await db.collection("shops").doc(shopId).collection("deliveryCalls").doc(callId).set({
    offeredRiderIds: FieldValue.arrayUnion(nearest.id),
    currentOfferId: offerRef.id,
  }, { merge: true });

  console.log(`অফার পাঠানো হয়েছে — riderId: ${nearest.id}, দূরত্ব: ${nearest.distanceKm.toFixed(1)} কিমি`);
  return offerRef.id;
}

exports.onDeliveryCall = onDocumentCreated(
  { document: "shops/{shopId}/deliveryCalls/{callId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const shopId = event.params.shopId;
    const callId = event.params.callId;
    const callData = event.data.data();

    const shopDoc = await db.collection("shops").doc(shopId).get();
    const shopName = (shopDoc.exists && (shopDoc.data().name || shopDoc.data().shopName)) || "দোকান";

    await notifyLegacyDevices(shopId, shopName);
    await dispatchToNearestRider(shopId, callId, callData, []);
  }
);

/* ==================== 🆕 3. Bazar Order Auto-Dispatch (orderRequests) ====================
   dispatchToNearestRider (উপরে, সিস্টেম ২)-এর থেকে ইচ্ছাকৃতভাবে সম্পূর্ণ
   আলাদা ফাংশন — যাতে এই নতুন লজিকের কোনো বাগ পুরনো deliveryCalls সিস্টেমকে
   কখনো প্রভাবিত করতে না পারে। */

// 🎯 এলিজিবল ডেলিভারি-রাইডার — Step 3-এ অনুমোদিত ঠিক এই ৪ শর্ত
function riderEligibilityQuery() {
  return db.collection("riders")
    .where("online", "==", true)
    .where("transportModeOn", "==", false)
    .where("status", "==", "active")
    .where("currentStatus", "==", "available");
}

async function dispatchOrderToNearestRider(orderId, orderData, excludeRiderIds) {
  const shopDoc = await db.collection("shops").doc(orderData.shopId).get();
  const shopData = shopDoc.exists ? shopDoc.data() : {};
  const shopName = shopData.name || shopData.shopName || "দোকান";
  const shopMarketId = shopData.marketId || null;
  const storeLoc = shopData.storeLocation || null;
  const dropLoc = (orderData.deliveryLat != null && orderData.deliveryLng != null)
    ? { lat: orderData.deliveryLat, lng: orderData.deliveryLng } : null;

  const ridersSnap = await riderEligibilityQuery().get();
  let candidates = ridersSnap.docs
    .filter((d) => !excludeRiderIds.includes(d.id))
    .map((d) => ({ id: d.id, ...d.data() }));

  if (candidates.length === 0) {
    console.log(JSON.stringify({ event: "NO_RIDER_AVAILABLE", orderId }));
    await db.collection("orderRequests").doc(orderId).set({ dispatchState: "waiting_for_rider" }, { merge: true });
    return null;
  }

  // 📦 প্রতিটা প্রার্থীর বর্তমান ওয়ার্কলোড (এখন কতগুলো shipped অর্ডার হাতে
  // আছে) — capacity-এর বেশি থাকলে বাদ, নাহলে workload-ranking-এ ব্যবহার হয়।
  // ⚠️ এই কোয়েরির জন্য নতুন Firestore composite index লাগতে পারে
  // (assignedRiderId 'in' + status '=='); index না থাকলে/প্রথমবার এরর
  // দিলেও যাতে পুরো dispatch ব্যর্থ না হয়ে যায়, তাই try/catch — ব্যর্থ
  // হলে workload/route-batching বাদ দিয়ে শুধু market+distance দিয়েই এগোবে।
  let workloadByRider = {}, routeMarketByRider = {};
  try {
    const workloadSnap = await db.collection("orderRequests")
      .where("assignedRiderId", "in", candidates.map((c) => c.id).slice(0, 30)) // Firestore 'in' সর্বোচ্চ ৩০
      .where("status", "==", "shipped")
      .get();
    workloadSnap.docs.forEach((d) => {
      const o = d.data();
      workloadByRider[o.assignedRiderId] = (workloadByRider[o.assignedRiderId] || 0) + 1;
      // shopMarketId নিচে dispatch-এর সময় প্রতিটা অর্ডারে লিখে রাখা হয়
      // (route-batching-এর জন্য), তাই এখানে সরাসরি পড়া যায়, আলাদা করে
      // shop ডকুমেন্ট আবার fetch করতে হয় না
      if (o.shopMarketId) {
        routeMarketByRider[o.assignedRiderId] = routeMarketByRider[o.assignedRiderId] || new Set();
        routeMarketByRider[o.assignedRiderId].add(o.shopMarketId);
      }
    });
  } catch (e) {
    console.warn("workload/route-batching কোয়েরি ব্যর্থ (সম্ভবত মিসিং ইনডেক্স) — শুধু market+distance দিয়ে এগোনো হচ্ছে:", String(e && e.message || e));
  }

  candidates = candidates
    .map((r) => {
      r.workload = workloadByRider[r.id] || 0;
      r.hasCompatibleRoute = !!(shopMarketId && routeMarketByRider[r.id] && routeMarketByRider[r.id].has(shopMarketId));
      r.sameMarket = !!(shopMarketId && r.marketId === shopMarketId);
      r.distanceKm = (storeLoc && r.liveLocation && r.liveLocation.lat != null)
        ? haversineKm(storeLoc.lat, storeLoc.lng, r.liveLocation.lat, r.liveLocation.lng)
        : null;
      return r;
    })
    .filter((r) => r.workload < MAX_CONCURRENT_ORDERS_PER_RIDER); // ক্যাপাসিটি-সীমা

  if (candidates.length === 0) {
    console.log(JSON.stringify({ event: "NO_RIDER_AVAILABLE", orderId, reason: "all_at_capacity" }));
    await db.collection("orderRequests").doc(orderId).set({ dispatchState: "waiting_for_rider" }, { merge: true });
    return null;
  }

  // 🏆 Priority: ১) Compatible route ২) Same market ৩) কম workload ৪) কাছের দূরত্ব
  candidates.sort((a, b) => {
    if (a.hasCompatibleRoute !== b.hasCompatibleRoute) return a.hasCompatibleRoute ? -1 : 1;
    if (a.sameMarket !== b.sameMarket) return a.sameMarket ? -1 : 1;
    if (a.workload !== b.workload) return a.workload - b.workload;
    const ad = a.distanceKm == null ? Infinity : a.distanceKm;
    const bd = b.distanceKm == null ? Infinity : b.distanceKm;
    return ad - bd;
  });
  const chosen = candidates[0];

  // 📏 শুধু চূড়ান্ত বাছাই-করা রাইডারের জন্যই Google Distance Matrix কল করা
  // হয় (API খরচ বাঁচাতে) — বাকিদের জন্য Haversine-ই যথেষ্ট ছিল ranking-এ
  let finalDistanceKm = chosen.distanceKm;
  if (storeLoc && chosen.liveLocation && chosen.liveLocation.lat != null) {
    const roadDist = await getRoadDistanceKm(storeLoc.lat, storeLoc.lng, chosen.liveLocation.lat, chosen.liveLocation.lng);
    finalDistanceKm = roadDist.distanceKm;
  }

  const expiresAt = Timestamp.fromMillis(Date.now() + OFFER_TIMEOUT_SECONDS * 1000);
  const offerRef = await db.collection("deliveryOffers").add({
    shopId: orderData.shopId, orderId, // 🔗 callId-এর জায়গায় orderId — একই কালেকশন পুনর্ব্যবহার
    riderId: chosen.id,
    status: "pending",
    pickupName: shopName,
    pickupLat: storeLoc ? storeLoc.lat : null, pickupLng: storeLoc ? storeLoc.lng : null,
    dropLat: dropLoc ? dropLoc.lat : null, dropLng: dropLoc ? dropLoc.lng : null,
    dropAddress: orderData.deliveryAddress || null, // ইতিমধ্যেই আছে — নতুন করে reverse-geocode করতে হয়নি
    distanceKm: finalDistanceKm != null ? Math.round(finalDistanceKm * 10) / 10 : null,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  await db.collection("orderRequests").doc(orderId).set({
    dispatchState: "offer_sent",
    offeredRiderIds: FieldValue.arrayUnion(chosen.id),
    currentOfferId: offerRef.id,
    shopMarketId: shopMarketId || null, // Route Batching-এর জন্য — এই অর্ডারটা কোন মার্কেটের তা এখানেই থেকে যায়
  }, { merge: true });

  console.log(JSON.stringify({
    event: "RIDER_SELECTED", orderId, riderId: chosen.id,
    hasCompatibleRoute: chosen.hasCompatibleRoute, sameMarket: chosen.sameMarket,
    workload: chosen.workload, distanceKm: finalDistanceKm
  }));
  console.log(JSON.stringify({ event: "OFFER_CREATED", orderId, offerId: offerRef.id, riderId: chosen.id }));

  await sendFcmToRider(
    chosen.id,
    "🚚 নতুন Delivery Order",
    "আপনার কাছে একটি Delivery Offer এসেছে — ১ মিনিটের মধ্যে গ্রহণ করুন",
    { offerId: offerRef.id, orderId }
  );

  return offerRef.id;
}

// 🚀 dispatch-এর সূচনা বিন্দু — orderRequests-এ status pending→preparing
// হলেই ট্রিগার হয় (existing flow অক্ষত, কোনো নতুন status বানানো হয়নি)
exports.onOrderConfirmed = onDocumentUpdated(
  { document: "orderRequests/{orderId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const orderId = event.params.orderId;

    // ⚠️ শর্ত ঠিক এইভাবেই — status সত্যিই বদলেছে এবং নতুন মান "preparing"।
    // অন্য কোনো ফিল্ড বদলালে (যেমন শুধু deliveryAddress এডিট) পুনরায়
    // dispatch শুরু হবে না।
    if (before.status === after.status) return;
    if (after.status !== "preparing") return;
    // ইতিমধ্যে dispatch শুরু হয়ে থাকলে (রেট্রি/ডুপ্লিকেট ইভেন্ট) আবার শুরু করব না
    if (after.dispatchState) return;

    console.log(JSON.stringify({ event: "ORDER_DISPATCH_STARTED", orderId }));
    await db.collection("orderRequests").doc(orderId).set({ dispatchState: "searching_rider" }, { merge: true });
    await dispatchOrderToNearestRider(orderId, after, []);
  }
);

exports.onOfferResolved = onDocumentUpdated(
  { document: "deliveryOffers/{offerId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (before.status === after.status) return;
    if (after.status !== "skipped" && after.status !== "expired") return;

    if (after.orderId) {
      // 🆕 orderRequests-চালিত অফার — পরের প্রার্থীকে খোঁজা
      console.log(JSON.stringify({ event: "OFFER_EXPIRED", orderId: after.orderId, riderId: after.riderId }));
      const orderSnap = await db.collection("orderRequests").doc(after.orderId).get();
      if (!orderSnap.exists) return;
      const orderData = orderSnap.data();
      if (orderData.status !== "preparing" || orderData.dispatchState === "assigned") return;

      const excludeIds = orderData.offeredRiderIds || [];
      const nextOfferId = await dispatchOrderToNearestRider(after.orderId, orderData, excludeIds);
      if (nextOfferId) {
        console.log(JSON.stringify({ event: "NEXT_RIDER_SELECTED", orderId: after.orderId }));
      }
      return;
    }

    // পুরনো deliveryCalls-চালিত অফার — অপরিবর্তিত আচরণ
    const callRef = db.collection("shops").doc(after.shopId).collection("deliveryCalls").doc(after.callId);
    const callSnap = await callRef.get();
    if (!callSnap.exists) return;
    const callData = callSnap.data();

    if (callData.status === "delivered" || callData.assignedRiderId) return;

    const excludeIds = callData.offeredRiderIds || [];
    await dispatchToNearestRider(after.shopId, after.callId, callData, excludeIds);
  }
);

exports.onOfferAccepted = onDocumentUpdated(
  "deliveryOffers/{offerId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (before.status === after.status || after.status !== "accepted") return;

    if (after.orderId) {
      // 🆕 orderRequests-চালিত অফার — Firestore transaction দিয়ে ডুপ্লিকেট-এসাইনমেন্ট প্রতিরোধ
      const orderRef = db.collection("orderRequests").doc(after.orderId);
      const riderDoc = await db.collection("riders").doc(after.riderId).get();
      const riderName = riderDoc.exists ? riderDoc.data().name : null;

      const assigned = await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) return false;
        const orderData = orderSnap.data();

        // ✅ ইতিমধ্যে অন্য কোনো রাইডারকে এসাইন করা থাকলে (রেস কন্ডিশন/ডুপ্লিকেট
        // ইভেন্ট) — দ্বিতীয়বার লেখা হবে না
        if (orderData.assignedRiderId || orderData.dispatchState === "assigned") {
          return false;
        }

        tx.set(orderRef, {
          status: "shipped",
          assignedRiderId: after.riderId,
          assignedRiderName: riderName,
          riderAssignedAt: FieldValue.serverTimestamp(),
          shippedAt: FieldValue.serverTimestamp(),
          dispatchState: "assigned",
        }, { merge: true });
        return true;
      });

      if (assigned) {
        console.log(JSON.stringify({ event: "ORDER_ASSIGNED", orderId: after.orderId, riderId: after.riderId }));
        console.log(JSON.stringify({ event: "OFFER_ACCEPTED", orderId: after.orderId, riderId: after.riderId }));
      } else {
        console.log(JSON.stringify({ event: "DUPLICATE_ASSIGNMENT_BLOCKED", orderId: after.orderId, riderId: after.riderId }));
      }
      return;
    }

    // পুরনো deliveryCalls-চালিত অফার — অপরিবর্তিত আচরণ
    await db.collection("shops").doc(after.shopId).collection("deliveryCalls").doc(after.callId).set({
      assignedRiderId: after.riderId,
      status: "picked_up",
    }, { merge: true });
  }
);

exports.checkExpiredOffers = onSchedule("every 2 minutes", async () => {
  const now = Timestamp.now();
  const expiredSnap = await db.collection("deliveryOffers")
    .where("status", "==", "pending")
    .where("expiresAt", "<", now)
    .get();

  if (expiredSnap.empty) return;

  // এই আপডেটই onOfferResolved ট্রিগার করবে (উপরে) — সেখানেই পরের রাইডার
  // খোঁজার লজিক আছে, তাই এখানে ডুপ্লিকেট করার দরকার নেই
  await Promise.all(
    expiredSnap.docs.map((doc) => doc.ref.update({ status: "expired" }))
  );
  console.log(`${expiredSnap.size}টা মেয়াদোত্তীর্ণ অফার আপডেট করা হয়েছে`);
});

/* ==================== 🖼️ Orphan Image Cleanup — Step 6 ====================
   ⚠️ বিদ্যমান Cloud Functions আর্কিটেকচার পুনর্ব্যবহার করা হয়েছে — নতুন
   কোনো initializeApp()/দ্বিতীয় Firebase app নেই, একই db/existing
   onSchedule-প্যাটার্ন (checkExpiredOffers-এর ঠিক পাশেই) অনুসরণ করা হয়েছে।

   দিনে একবার চলে (প্রতি ঘণ্টায় দরকার নেই, নির্দেশনা অনুযায়ী)। প্রতিটা
   ORPHAN + ২৪ঘণ্টা-পুরনো ছবির জন্য: আবার fresh read করে referenceCount
   এখনো 0 কিনা যাচাই (রেস-কন্ডিশন সুরক্ষা) → Storage-এ ফাইল আছে কিনা
   চেক → ডিলিট → তারপরই Firestore ডকুমেন্ট ডিলিট। কোনো ধাপেই
   referenceCount > 0 পাওয়া গেলে সাথে সাথে বাতিল (active ছবি কখনো ছোঁয়া হয় না)। */
const ORPHAN_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // ২৪ ঘণ্টা

exports.cleanupOrphanImages = onSchedule("every 24 hours", async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - ORPHAN_GRACE_PERIOD_MS);

  const orphanSnap = await db.collection("imageIndex")
    .where("cleanupStatus", "==", "ORPHAN")
    .where("orphanedAt", "<", cutoff)
    .get();

  if (orphanSnap.empty) {
    console.log(JSON.stringify({ event: "IMAGE_CLEANUP_NONE_FOUND" }));
    return;
  }

  const bucket = getStorage().bucket();
  let deletedCount = 0, skippedCount = 0, errorCount = 0;

  for (const doc of orphanSnap.docs) {
    const imageId = doc.id;
    try {
      // 🔒 রেস-কন্ডিশন সুরক্ষা — ডিলিটের ঠিক আগে আবার fresh read (Test E-এর
      // পরিস্থিতি হ্যান্ডল করে: এই মাঝের সময়ে কেউ ছবিটা আবার ব্যবহার করে ফেললে)
      const freshDoc = await db.collection("imageIndex").doc(imageId).get();
      if (!freshDoc.exists) {
        console.log(JSON.stringify({ event: "IMAGE_CLEANUP_SKIPPED", imageId, reason: "already_deleted" }));
        skippedCount++;
        continue;
      }
      const freshData = freshDoc.data();
      if ((freshData.referenceCount || 0) > 0 || freshData.cleanupStatus !== "ORPHAN") {
        // ✅ ছবিটা এই মাঝের সময়ে আবার ব্যবহৃত হয়েছে — delete বাতিল, active ছবি স্পর্শ করা হয়নি
        console.log(JSON.stringify({ event: "IMAGE_CLEANUP_CANCELLED_STILL_ACTIVE", imageId, referenceCount: freshData.referenceCount }));
        skippedCount++;
        continue;
      }

      const storagePath = freshData.storagePath;
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();

      if (exists) {
        await file.delete();
        console.log(JSON.stringify({ event: "IMAGE_STORAGE_DELETED", imageId, storagePath }));
      } else {
        // Storage-এ ফাইল নেই কিন্তু imageIndex ডকুমেন্ট আছে (অসামঞ্জস্যপূর্ণ) —
        // নিরাপদে ধরে নেওয়া হয় ফাইল আগেই মুছে গেছে, শুধু Firestore ডকুমেন্ট পরিষ্কার করা হবে
        console.warn(JSON.stringify({ event: "IMAGE_STORAGE_FILE_ALREADY_MISSING", imageId, storagePath }));
      }

      try {
        await db.collection("imageIndex").doc(imageId).delete();
        console.log(JSON.stringify({ event: "IMAGE_INDEX_DELETED", imageId }));
        deletedCount++;
      } catch (fsErr) {
        // ⚠️ Storage থেকে মুছে ফেলা হয়েছে কিন্তু Firestore ডকুমেন্ট মুছতে ব্যর্থ —
        // বারবার চেষ্টা করে ডেটা-লস ঘটানো হচ্ছে না, পরের রানেই reconcile হবে
        console.error(JSON.stringify({ event: "IMAGE_INDEX_DELETE_FAILED_WILL_RECONCILE", imageId, error: String(fsErr && fsErr.message || fsErr) }));
        errorCount++;
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "IMAGE_CLEANUP_ERROR", imageId, error: String(e && e.message || e) }));
      errorCount++;
    }
  }

  console.log(JSON.stringify({ event: "IMAGE_CLEANUP_SUMMARY", deletedCount, skippedCount, errorCount, totalChecked: orphanSnap.size }));
});

// 🔄 রাইডার এলিজিবল হয়ে উঠলেই (Online করলেন / Transport Mode বন্ধ করে
// Delivery-তে ফিরলেন / Available হলেন) — অপেক্ষমাণ (waiting_for_rider)
// অর্ডারগুলো আবার চেষ্টা করা হয়। দোকানদারকে কিছু করতে হয় না।
exports.onRiderBecomesEligible = onDocumentUpdated(
  { document: "riders/{riderId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const riderId = event.params.riderId;

    const wasEligible = before.online === true && before.transportModeOn === false
      && before.status === "active" && before.currentStatus === "available";
    const isEligible = after.online === true && after.transportModeOn === false
      && after.status === "active" && after.currentStatus === "available";

    if (wasEligible || !isEligible) return; // শুধু "না-এলিজিবল থেকে এলিজিবল" এই ট্রানজিশনেই আগ্রহী

    const waitingSnap = await db.collection("orderRequests")
      .where("dispatchState", "==", "waiting_for_rider")
      .limit(20)
      .get();
    if (waitingSnap.empty) return;

    console.log(JSON.stringify({ event: "QUEUE_RETRY", riderId, waitingOrders: waitingSnap.size }));

    for (const doc of waitingSnap.docs) {
      const orderData = doc.data();
      if (orderData.status !== "preparing") continue; // ইতিমধ্যে অন্যভাবে এগিয়ে গেছে
      const excludeIds = orderData.offeredRiderIds || [];
      await dispatchOrderToNearestRider(doc.id, orderData, excludeIds);
    }
  }
);

/* ==================== 🐝 Shopping Assistant — AI-এর জন্য নিরাপদ server-side interface (Step 2) ====================
   ⚠️ সততার সাথে: এখানে কোনো real AI API (Anthropic/OpenAI/Gemini ইত্যাদি)
   এখনো যুক্ত করা হয়নি — কোনো key ফ্যাব্রিকেট/হার্ডকোড করিনি, কারণ কোনো
   বাস্তব key নেই। এই ফাংশনটা শুধু নিরাপদ আর্কিটেকচারের "কাঠামো" —
   ক্লায়েন্ট → এই Cloud Function → (ভবিষ্যতে) AI API secret দিয়ে কল →
   structured intent রিটার্ন। আপাতত এটা client-এর মতোই একটা সাধারণ
   নিয়ম-ভিত্তিক পার্সার ব্যবহার করে (honey-bee-bazar.html-এর
   hbParseShoppingText-এর সমতুল্য, সার্ভার-সাইড সংস্করণ) — যাতে
   contract/response-shape টা এখনই ঠিক করে রাখা যায়, পরে শুধু ভেতরের
   লজিকটা real AI কল দিয়ে replace করলেই হবে, client-side কোড বদলাতে
   হবে না।

   ⚠️ বর্তমানে honey-bee-bazar.html client এই ফাংশনটা এখনো কল করছে না
   (এখনো লোকাল rule-based parser-ই ব্যবহার করছে) — এটা শুধু ভবিষ্যতের
   জন্য কাঠামো প্রস্তুত রাখা, এখনই client-কে এটার সাথে যুক্ত করা হয়নি।

   কখনোই এই ফাংশন Firestore-এ write করে না — শুধু টেক্সট পার্স করে
   ফেরত পাঠায়, বাকি (search/cart) client-সাইডেই বিদ্যমান ফাংশন দিয়ে হয়। */
const BN_DIGIT_MAP_SERVER = { "০":"0","১":"1","২":"2","৩":"3","৪":"4","৫":"5","৬":"6","৭":"7","৮":"8","৯":"9" };
const BN_NUMBER_WORDS_SERVER = {
  "একটা":1,"একটি":1,"এক":1, "দুইটা":2,"দুটা":2,"দুটো":2,"দুই":2,
  "তিনটা":3,"তিন":3, "চারটা":4,"চার":4, "পাঁচটা":5,"পাঁচ":5,
};
const UNIT_WORDS_SERVER = ["কেজি","গ্রাম","লিটার","পিস","পিছ","বোতল","প্যাকেট","হালি","ডজন","কৌটা","আঁটি"];

const FILLER_WORDS_SERVER = ["লাগবে","দাও","চাই","নেব","লাগবেই","একটু","আমাকে","আমার","জন্য","দিন","হবে","ভাই","আজকে","আজ","বাসার","বাজার","করে","কিছু","প্লিজ","আরও","আরো","আরেকটু","বাড়াও","বাড়িয়ে","বাদ","মুছে","সরিয়ে","সরাও","আর","যোগ","করো","করুন","দরকার","নেই"];

function parseShoppingSegmentServer(segment) {
  let text = segment.trim().replace(/[০-৯]/g, (d) => BN_DIGIT_MAP_SERVER[d] || d);
  let qty = 1, unit = null;

  const digitMatch = text.match(/(\d+(?:\.\d+)?)\s*(কেজি|গ্রাম|লিটার|পিস|পিছ|বোতল|প্যাকেট|হালি|ডজন|কৌটা|আঁটি)?/);
  if (digitMatch) {
    qty = parseFloat(digitMatch[1]);
    unit = digitMatch[2] || null;
    text = text.replace(digitMatch[0], " ");
  } else {
    for (const word of Object.keys(BN_NUMBER_WORDS_SERVER)) {
      if (text.includes(word)) {
        qty = BN_NUMBER_WORDS_SERVER[word];
        text = text.replace(word, " ");
        const unitMatch = text.match(new RegExp("(" + UNIT_WORDS_SERVER.join("|") + ")"));
        if (unitMatch) { unit = unitMatch[1]; text = text.replace(unitMatch[0], " "); }
        break;
      }
    }
  }
  FILLER_WORDS_SERVER.forEach((w) => { text = text.replace(new RegExp(w, "g"), " "); });
  return { rawText: segment.trim(), qty, unit, itemQuery: text.replace(/\s+/g, " ").trim() };
}

function ruleBasedParse(text) {
  const segments = text.split(/[,،।.]|(?:\s+এবং\s+)|(?:\s+আর\s+)|(?:\s+ও\s+)|\n/).map((s) => s.trim()).filter(Boolean);
  return segments.map(parseShoppingSegmentServer).filter((s) => s.itemQuery.length > 0);
}

// 🤖 Gemini দিয়ে বাংলা শপিং-বাক্য থেকে structured items বের করা — AI-কে
// কড়াকড়িভাবে বলা হয় শুধু {itemQuery, qty, unit} ফেরত দিতে, কোনো
// productId/price/stock বানাতে বলা হয় না (ওগুলো AI-এর প্রম্পটেও নেই,
// AI-এর আউটপুট শুধু items array হিসেবে পার্স হয়, অন্য কিছু গ্রহণ করা হয় না)।
async function geminiParse(text, apiKey) {
  const prompt = `তুমি একটা বাংলা মুদি-বাজারের শপিং লিস্ট পার্সার। নিচের কাস্টমারের কথা থেকে প্রতিটা প্রোডাক্টের নাম, পরিমাণ ও একক বের করো।
নিয়ম:
- শুধু JSON array রিটার্ন করবে, অন্য কোনো টেক্সট না।
- প্রতিটা আইটেম: {"itemQuery": "প্রোডাক্টের সাধারণ নাম", "qty": সংখ্যা, "unit": "কেজি"/"লিটার"/"পিস"/null}
- "ডজন" হলে qty ১২ দিয়ে গুণ করে unit "পিস" দেবে। "হালি" হলে ৪ দিয়ে গুণ করবে।
- কোনো প্রোডাক্ট আইডি, দাম, বা স্টক বানাবে না — শুধু গ্রাহক কী চেয়েছেন তা বুঝে দাও।
- সম্বোধন/ভদ্রতা-সূচক শব্দ (ভাই, প্লিজ, দাও, লাগবে) বাদ দিয়ে শুধু প্রোডাক্টের নাম রাখবে।

কাস্টমারের কথা: "${text}"

শুধু JSON array রিটার্ন করো, যেমন: [{"itemQuery":"চাল","qty":5,"unit":"কেজি"}]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API status ${res.status}`);
  const data = await res.json();
  const rawText = data.candidates && data.candidates[0] && data.candidates[0].content
    && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
    && data.candidates[0].content.parts[0].text;
  if (!rawText) throw new Error("Gemini থেকে খালি রেসপন্স");

  const parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) throw new Error("Gemini রেসপন্স array না");

  // ⚠️ AI-এর আউটপুট বিশ্বাস করার আগে ভ্যালিডেট করা হয় — শুধু প্রত্যাশিত
  // shape-এর ফিল্ডই গ্রহণ করা হয়, অতিরিক্ত কিছু (productId/price ইত্যাদি
  // AI ভুল করে দিয়ে ফেললেও) ছেঁকে ফেলা হয়
  return parsed
    .filter((it) => it && typeof it.itemQuery === "string" && it.itemQuery.trim())
    .map((it) => ({
      rawText: it.itemQuery,
      itemQuery: it.itemQuery.trim(),
      qty: typeof it.qty === "number" && it.qty > 0 ? it.qty : 1,
      unit: typeof it.unit === "string" ? it.unit : null,
    }));
}

exports.parseShoppingIntent = onCall({ secrets: [geminiApiKey] }, async (request) => {
  // 🔒 Security — শুধু লগইন-করা কাস্টমারই এই ফাংশন কল করতে পারবেন
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "এই ফিচার ব্যবহার করতে লগইন প্রয়োজন।");
  }
  const text = request.data && request.data.text;
  if (!text || typeof text !== "string") {
    throw new HttpsError("invalid-argument", "text (string) প্রয়োজন");
  }

  const apiKey = geminiApiKey.value();
  if (apiKey) {
    try {
      const items = await geminiParse(text, apiKey);
      if (items.length > 0) return { items, engine: "gemini-2.0-flash" };
      // AI খালি রেজাল্ট দিলে নিচে rule-based ফলব্যাকে যাওয়া হয়
    } catch (e) {
      console.warn("Gemini parse ব্যর্থ, rule-based fallback ব্যবহার হচ্ছে:", String(e && e.message || e));
    }
  }

  // 🛟 Fallback — Gemini key না থাকলে, বা কল ব্যর্থ হলে, বা খালি রেজাল্ট
  // দিলে — কখনো গ্রাহককে খালি হাতে ফেরত পাঠানো হয় না
  const items = ruleBasedParse(text);
  return { items, engine: "rule-based-fallback" };
});

exports.deleteAccount = onCall(async (request) => {
  try {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "লগইন করা নেই।");
    }

    const superAdminDoc = await db.collection("superadmins").doc(callerUid).get();
    if (!superAdminDoc.exists) {
      throw new HttpsError("permission-denied", "শুধু সুপার অ্যাডমিন অ্যাকাউন্ট ডিলিট করতে পারবেন।");
    }

    const { targetUid, accountType } = request.data || {};
    if (!targetUid || !["shop", "agent", "rider", "driver"].includes(accountType)) {
      throw new HttpsError("invalid-argument", "targetUid ও accountType (shop/agent/rider/driver) দিতে হবে।");
    }

    if (accountType === "shop") {
      await db.recursiveDelete(db.collection("shops").doc(targetUid));
    } else if (accountType === "agent") {
      await db.recursiveDelete(db.collection("agents").doc(targetUid));
    } else if (accountType === "rider") {
      await db.recursiveDelete(db.collection("riders").doc(targetUid));
    } else if (accountType === "driver") {
      await db.recursiveDelete(db.collection("transportDrivers").doc(targetUid));
    }
    await db.collection("users").doc(targetUid).delete().catch(() => {});

    try {
      await getAuth().deleteUser(targetUid);
    } catch (e) {
      if (e.code !== "auth/user-not-found") {
        throw new HttpsError("internal", "Firestore ডেটা মুছে গেছে, কিন্তু Auth অ্যাকাউন্ট মুছতে সমস্যা হয়েছে: " + e.message);
      }
    }

    return { success: true, deletedUid: targetUid, accountType };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("deleteAccount ব্যর্থ হয়েছে:", err);
    throw new HttpsError("internal", "ডিলিট করা যায়নি — " + (err && err.message ? err.message : String(err)));
  }
});

async function dispatchTripToNearestDriver(tripId, tripData, excludeDriverIds) {
  if (tripData.pickupLat == null || tripData.pickupLng == null) {
    console.log("পিকআপ লোকেশন নেই — trip dispatch স্কিপ করা হচ্ছে");
    return null;
  }

  const driversSnap = await db.collection("transportDrivers")
    .where("status", "==", "active")
    .where("isVerified", "==", true)
    .where("driverStatus", "==", "online")
    .get();

  let candidates = driversSnap.docs
    .filter((d) => !excludeDriverIds.includes(d.id))
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.liveLocation && d.liveLocation.lat != null);

  if (candidates.length === 0) {
    console.log("কোনো অনলাইন ড্রাইভার পাওয়া যায়নি");
    return null;
  }

  candidates.forEach((d) => {
    d.distanceKm = haversineKm(tripData.pickupLat, tripData.pickupLng, d.liveLocation.lat, d.liveLocation.lng);
  });
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  const nearest = candidates[0];

  const roadDist = await getRoadDistanceKm(tripData.pickupLat, tripData.pickupLng, tripData.dropLat, tripData.dropLng);
  const distanceKm = Math.round(roadDist.distanceKm * 10) / 10;
  const estimatedFare = Math.round((30 + distanceKm * 15) * 100) / 100;
  const driverEarning = Math.round(estimatedFare * 0.8 * 100) / 100;

  const expiresAt = Timestamp.fromMillis(Date.now() + 60 * 1000);
  const offerRef = await db.collection("tripOffers").add({
    tripId,
    driverId: nearest.id,
    status: "pending",
    pickupAddress: tripData.pickupAddress || null,
    dropAddress: tripData.dropAddress || null,
    distanceKm, estimatedFare, driverEarning,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  });

  await db.collection("trips").doc(tripId).set({
    offeredDriverIds: FieldValue.arrayUnion(nearest.id),
    currentOfferId: offerRef.id,
    distanceKm, estimatedFare, driverEarning,
  }, { merge: true });

  console.log(`ট্রিপ অফার পাঠানো হয়েছে — driverId: ${nearest.id}, দূরত্ব: ${nearest.distanceKm.toFixed(1)} কিমি`);
  return offerRef.id;
}

exports.onTripRequested = onDocumentCreated(
  { document: "trips/{tripId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const tripId = event.params.tripId;
    const tripData = event.data.data();
    if (tripData.status !== "requested") return;
    await dispatchTripToNearestDriver(tripId, tripData, []);
  }
);

exports.onTripOfferResolved = onDocumentUpdated(
  { document: "tripOffers/{offerId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (before.status === after.status) return;
    if (after.status !== "rejected" && after.status !== "expired") return;

    const tripSnap = await db.collection("trips").doc(after.tripId).get();
    if (!tripSnap.exists) return;
    const tripData = tripSnap.data();
    if (tripData.status !== "requested") return;

    const excludeIds = tripData.offeredDriverIds || [];
    await dispatchTripToNearestDriver(after.tripId, tripData, excludeIds);
  }
);

exports.onTripOfferAccepted = onDocumentUpdated(
  "tripOffers/{offerId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (before.status === after.status || after.status !== "accepted") return;

    await db.collection("trips").doc(after.tripId).set({
      driverId: after.driverId,
      status: "accepted",
    }, { merge: true });
  }
);

exports.checkExpiredTripOffers = onSchedule("every 2 minutes", async () => {
  const now = Timestamp.now();
  const expiredSnap = await db.collection("tripOffers")
    .where("status", "==", "pending")
    .where("expiresAt", "<", now)
    .get();
  if (expiredSnap.empty) return;
  await Promise.all(expiredSnap.docs.map((doc) => doc.ref.update({ status: "expired" })));
  console.log(`${expiredSnap.size}টা মেয়াদোত্তীর্ণ ট্রিপ অফার আপডেট করা হয়েছে`);
});

/* ==================== 🗑️ ৭ দিনের বেশি পুরনো হিস্ট্রি স্বয়ংক্রিয়ভাবে মুছে ফেলা ====================
   প্রতিদিন একবার চলে — সম্পন্ন হয়ে যাওয়া ট্রিপ, ডেলিভারি, ও রাস্তা থেকে
   পিক-আপের রেকর্ড ৭ দিনের পুরনো হয়ে গেলে Firestore থেকে স্থায়ীভাবে মুছে
   দেওয়া হয় (স্টোরেজ খরচ বাঁচাতে ও ডেটাবেজ পরিষ্কার রাখতে)।
   ⚠️ Step 18 — deploy-ফোল্ডারের পুরনো ভার্সনে এই ফাংশনটা ছিল, working
   copy-তে ছিল না — হারিয়ে না যায় সেজন্য অপরিবর্তিতভাবে ফিরিয়ে আনা হলো। */
exports.cleanupOldHistory = onSchedule("every 24 hours", async () => {
  const sevenDaysAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;

  // ১. সম্পন্ন ডেলিভারি অফার
  const oldDeliveries = await db.collection("deliveryOffers")
    .where("status", "==", "delivered")
    .where("createdAt", "<", sevenDaysAgo)
    .get();
  await Promise.all(oldDeliveries.docs.map((doc) => doc.ref.delete()));
  totalDeleted += oldDeliveries.size;

  // ২. সম্পন্ন গন্তব্য-ভিত্তিক ট্রিপ
  const oldTrips = await db.collection("trips")
    .where("status", "==", "completed")
    .where("createdAt", "<", sevenDaysAgo)
    .get();
  await Promise.all(oldTrips.docs.map((doc) => doc.ref.delete()));
  totalDeleted += oldTrips.size;

  // ৩. রাস্তা থেকে পিক-আপ করা যাত্রী (Zero Interaction) — created_at দিয়ে চেক
  const oldPickups = await db.collection("passenger_waiting_queue")
    .where("status", "in", ["PICKED_UP", "COMPLETED"])
    .where("created_at", "<", sevenDaysAgo)
    .get();
  await Promise.all(oldPickups.docs.map((doc) => doc.ref.delete()));
  totalDeleted += oldPickups.size;

  console.log(`🗑️ ৭ দিনের পুরনো ${totalDeleted}টা হিস্ট্রি রেকর্ড মুছে ফেলা হয়েছে`);
});

/* ==================== 🔐 Honey Messenger — প্রাইভেসি মোডের মেসেজ অটো-মুছে ফেলা ====================
   প্রতি মিনিটে চলে — যেসব মেসেজে expiresAt (মেসেজ পাঠানোর ১ মিনিট পর)
   অতিক্রান্ত হয়ে গেছে, সেগুলো স্থায়ীভাবে মুছে ফেলা হয়। collectionGroup
   দিয়ে সব চ্যাটের messages সাব-কালেকশন একসাথে চেক করা হয়।
   ⚠️ Step 18 — deploy-ফোল্ডারের পুরনো ভার্সনে এই ফাংশনটাও ছিল, working
   copy-তে ছিল না — অপরিবর্তিতভাবে ফিরিয়ে আনা হলো। */
exports.cleanupExpiredPrivacyMessages = onSchedule("every 1 minutes", async () => {
  const now = Timestamp.now();
  const expiredSnap = await db.collectionGroup("messages")
    .where("expiresAt", "<", now)
    .get();
  if (expiredSnap.empty) return;
  await Promise.all(expiredSnap.docs.map((doc) => doc.ref.delete()));
  console.log(`🔐 প্রাইভেসি মোডের ${expiredSnap.size}টা মেয়াদোত্তীর্ণ মেসেজ মুছে ফেলা হয়েছে`);
});
