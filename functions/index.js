/* ============================================================
   functions/index.js
   এই ফাইলে দুইটা আলাদা সিস্টেম আছে:

   ১. পুরনো সিস্টেম (legacy): দোকান "ডেলিভারি ম্যান কে ডাকুন" চাপলে
      shops/{shopId}/deliveryDevices-এ রেজিস্টার্ড ডিভাইসে (পুরনো
      delivery-man-app.html, শপ-কোড দিয়ে কানেক্ট করা) পুশ নোটিফিকেশন
      পাঠানো হয়। যেসব দোকান এখনো Agent/Rider সিস্টেমে যুক্ত হয়নি,
      তাদের জন্য এটা এখনো কাজ করবে।

   ২. নতুন সিস্টেম (Honey Bee Delivery App): Agent-এর মাধ্যমে
      নিবন্ধিত রাইডারদের মধ্যে সবচেয়ে কাছের অনলাইন রাইডারকে খুঁজে
      একটা "অফার" (deliveryOffers) তৈরি করা হয়, ৬০ সেকেন্ডের মধ্যে
      সাড়া না পেলে (স্কিপ/টাইমআউট) পরের কাছের রাইডারকে পাঠানো হয়।

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

initializeApp();
const db = getFirestore();

// 🔑 Google Maps API key — এটা কোডে সরাসরি লেখা নেই, Firebase Secrets Manager-এ
// রাখা হয় (`firebase functions:secrets:set GOOGLE_MAPS_API_KEY`), তাই এটা
// কখনো GitHub রিপোতে (পাবলিক হলেও) প্রকাশ পায় না — শুধু সার্ভার-সাইড এই
// ফাংশনগুলোর ভেতরেই ব্যবহার হয়, ক্লায়েন্ট/HTML-এ কখনো পাঠানো হয় না।
const googleMapsApiKey = defineSecret("GOOGLE_MAPS_API_KEY");

const OFFER_TIMEOUT_SECONDS = 60;
// রাইডার/এজেন্ট/হানি-বি — আয়ের ভাগ (Phase 5 ব্লুপ্রিন্ট অনুযায়ী: ৭০/২০/১০)
const RIDER_SHARE = 0.7;

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
// Firestore-এ ২ ঘণ্টার জন্য ক্যাশ করা হয় (স্পেকের "Firebase Cache" নির্দেশনা
// অনুযায়ী — Realtime Database-এর বদলে Firestore ব্যবহার করা হয়েছে, কারণ
// এই প্রজেক্টে এখনো Realtime Database সেটআপ করা নেই, Firestore-ই যথেষ্ট)।
// API কল ব্যর্থ হলে সরলরেখার (Haversine) দূরত্বে নিরাপদে ফলব্যাক করে।
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

  // ফলব্যাক — API key না থাকলে বা কল ব্যর্থ হলে সরলরেখার দূরত্ব
  return { distanceKm: haversineKm(originLat, originLng, destLat, destLng), durationMin: null, source: "haversine-fallback" };
}

// OpenStreetMap Nominatim দিয়ে ফ্রি রিভার্স-জিওকোডিং (key লাগে না) — ব্যর্থ
// হলে শুধু কোঅর্ডিনেট স্ট্রিং হিসেবে ফলব্যাক করে, ফাংশন কখনো ভেঙে পড়বে না
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

/* ---------- পুরনো সিস্টেম: legacy delivery-man-app.html ডিভাইসে পুশ ---------- */
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
      fcmOptions: { link: "https://YOUR-DOMAIN-HERE/delivery-man-app.html" },
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

/* ---------- নতুন সিস্টেম: সবচেয়ে কাছের অনলাইন রাইডারকে অফার পাঠানো ---------- */
async function dispatchToNearestRider(shopId, callId, callData, excludeRiderIds) {
  const shopDoc = await db.collection("shops").doc(shopId).get();
  const shopData = shopDoc.exists ? shopDoc.data() : {};
  const shopName = shopData.name || shopData.shopName || "দোকান";
  const storeLoc = shopData.storeLocation;

  if (!storeLoc || !callData.customerLocation) {
    console.log("দোকান বা কাস্টমারের লোকেশন নেই — geo-dispatch স্কিপ করা হচ্ছে");
    return null;
  }

  // সব অনলাইন, সক্রিয় রাইডার আনা হচ্ছে (এখনো market/agent-ভিত্তিক ফিল্টার
  // করা হচ্ছে না, কারণ শপ রেজিস্ট্রেশনে এখনো বাজার নির্বাচন যুক্ত হয়নি)
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

  // 📏 র‍্যাংকিং-এর জন্য সরলরেখা (দ্রুত, অনেক প্রার্থীর মধ্যে বাছাই করতে সস্তা),
  // কিন্তু চূড়ান্ত/দেখানো দূরত্বের জন্য সবচেয়ে কাছের প্রার্থীর জন্যই একবার
  // Google Distance Matrix দিয়ে আসল রোড-ডিস্ট্যান্স আনা হয় (কম খরচে)
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

/* ---------- ট্রিগার ১: নতুন ডেলিভারি কল তৈরি হলে ---------- */
exports.onDeliveryCall = onDocumentCreated(
  { document: "shops/{shopId}/deliveryCalls/{callId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const shopId = event.params.shopId;
    const callId = event.params.callId;
    const callData = event.data.data();

    const shopDoc = await db.collection("shops").doc(shopId).get();
    const shopName = (shopDoc.exists && (shopDoc.data().name || shopDoc.data().shopName)) || "দোকান";

    // পুরনো সিস্টেম (শপ-কোড কানেক্টেড ডিভাইস) — এখনো সাপোর্ট করা হচ্ছে
    await notifyLegacyDevices(shopId, shopName);

    // নতুন সিস্টেম (Agent-নিবন্ধিত রাইডার, geo-dispatch)
    await dispatchToNearestRider(shopId, callId, callData, []);
  }
);

/* ---------- ট্রিগার ২: রাইডার স্কিপ করলে বা অফার এক্সপায়ার হলে — পরের কাছের রাইডারকে পাঠানো ---------- */
exports.onOfferResolved = onDocumentUpdated(
  { document: "deliveryOffers/{offerId}", secrets: [googleMapsApiKey] },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (before.status === after.status) return; // স্ট্যাটাস আসলেই বদলায়নি
    if (after.status !== "skipped" && after.status !== "expired") return;

    const callRef = db.collection("shops").doc(after.shopId).collection("deliveryCalls").doc(after.callId);
    const callSnap = await callRef.get();
    if (!callSnap.exists) return;
    const callData = callSnap.data();

    if (callData.status === "delivered" || callData.assignedRiderId) return; // ইতিমধ্যে অন্য কেউ নিয়ে নিয়েছে

    const excludeIds = callData.offeredRiderIds || [];
    await dispatchToNearestRider(after.shopId, after.callId, callData, excludeIds);
  }
);

/* ---------- ট্রিগার ৩: রাইডার অ্যাকসেপ্ট করলে কলের সাথে লিংক করা ---------- */
exports.onOfferAccepted = onDocumentUpdated(
  "deliveryOffers/{offerId}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    if (before.status === after.status || after.status !== "accepted") return;

    await db.collection("shops").doc(after.shopId).collection("deliveryCalls").doc(after.callId).set({
      assignedRiderId: after.riderId,
      status: "picked_up",
    }, { merge: true });
  }
);

/* ---------- ট্রিগার ৪ (সেফটি-নেট): অ্যাপ বন্ধ থাকলে বা ৬০ সেকেন্ড কেউ সাড়া না দিলে ---------- */
exports.checkExpiredOffers = onSchedule("every 2 minutes", async () => {
  const now = Timestamp.now();
  const expiredSnap = await db.collection("deliveryOffers")
    .where("status", "==", "pending")
    .where("expiresAt", "<", now)
    .get();

  if (expiredSnap.empty) return;

  await Promise.all(
    expiredSnap.docs.map((doc) => doc.ref.update({ status: "expired" }))
  );
  console.log(`${expiredSnap.size}টা মেয়াদোত্তীর্ণ অফার আপডেট করা হয়েছে`);
});

/* ==================== 🗑️ অ্যাকাউন্ট ডিলিট + জিমেইল ফ্রি করা ====================
   শুধু ক্লায়েন্ট থেকে Firestore ডকুমেন্ট মুছে দিলে Firebase Authentication-এ
   ইমেইলটা "ব্যবহৃত" হিসেবেই থেকে যায় — তাই একই ইমেইল দিয়ে আবার সাইন-আপ করা
   যায় না। এই ফাংশনটা (শুধু Admin SDK দিয়েই সম্ভব, ক্লায়েন্ট থেকে না):
   ১. Firestore থেকে ইউজারের সব ডেটা (সাব-কালেকশনসহ) মুছে দেয়
   ২. Firebase Authentication থেকে অ্যাকাউন্টটাই মুছে দেয় — এতে ইমেইলটা
      সম্পূর্ণ ফ্রি হয়ে যায়, সাথে সাথে আবার রেজিস্ট্রেশনে ব্যবহার করা যাবে। */
exports.deleteAccount = onCall(async (request) => {
  try {
    const callerUid = request.auth && request.auth.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "লগইন করা নেই।");
    }

    // কলার সত্যিই সুপার অ্যাডমিন কিনা যাচাই করা (Admin SDK দিয়ে, তাই নিরাপদ —
    // ক্লায়েন্ট এখানে মিথ্যা দাবি করতে পারবে না)
    const superAdminDoc = await db.collection("superadmins").doc(callerUid).get();
    if (!superAdminDoc.exists) {
      throw new HttpsError("permission-denied", "শুধু সুপার অ্যাডমিন অ্যাকাউন্ট ডিলিট করতে পারবেন।");
    }

    const { targetUid, accountType } = request.data || {};
    if (!targetUid || !["shop", "agent", "rider", "driver"].includes(accountType)) {
      throw new HttpsError("invalid-argument", "targetUid ও accountType (shop/agent/rider/driver) দিতে হবে।");
    }

    // ১. Firestore থেকে ডেটা মুছে ফেলা (সাব-কালেকশনসহ, recursiveDelete দিয়ে)
    if (accountType === "shop") {
      await db.recursiveDelete(db.collection("shops").doc(targetUid));
    } else if (accountType === "agent") {
      await db.recursiveDelete(db.collection("agents").doc(targetUid));
    } else if (accountType === "rider") {
      await db.recursiveDelete(db.collection("riders").doc(targetUid));
    } else if (accountType === "driver") {
      await db.recursiveDelete(db.collection("transportDrivers").doc(targetUid));
    }
    // users/{uid} — লগইন রোল-ডকুমেন্ট, সব ধরনের অ্যাকাউন্টের জন্যই থাকে
    await db.collection("users").doc(targetUid).delete().catch(() => {});

    // ২. Firebase Authentication থেকে মুছে ফেলা — এতেই ইমেইল ফ্রি হয়
    try {
      await getAuth().deleteUser(targetUid);
    } catch (e) {
      // অ্যাকাউন্ট আগে থেকেই Auth-এ না থাকলে (auth/user-not-found) সেটা সমস্যা না,
      // Firestore ডেটা তো মুছে গেছে already — কিন্তু অন্য কোনো এরর হলে জানানো দরকার
      if (e.code !== "auth/user-not-found") {
        throw new HttpsError("internal", "Firestore ডেটা মুছে গেছে, কিন্তু Auth অ্যাকাউন্ট মুছতে সমস্যা হয়েছে: " + e.message);
      }
    }

    return { success: true, deletedUid: targetUid, accountType };
  } catch (err) {
    // যেকোনো অপ্রত্যাশিত এরর হলেও (রিকার্সিভ-ডিলিট ব্যর্থ হওয়া, পারমিশন সমস্যা
    // ইত্যাদি) আসল কারণটা ক্লায়েন্টে দেখানো হয়, যাতে "internal" এর মতো
    // অস্পষ্ট মেসেজের বদলে ঠিক কী ভুল হয়েছে সেটা বোঝা যায়
    if (err instanceof HttpsError) throw err;
    console.error("deleteAccount ব্যর্থ হয়েছে:", err);
    throw new HttpsError("internal", "ডিলিট করা যায়নি — " + (err && err.message ? err.message : String(err)));
  }
});

/* ==================== 🚑 ট্রান্সপোর্ট ট্রিপ ডিসপ্যাচ ====================
   কাস্টমার একটা trips ডকুমেন্ট (status:'requested') তৈরি করলে, এই ফাংশন
   সবচেয়ে কাছের অনলাইন ড্রাইভারকে খুঁজে ৬০ সেকেন্ডের একটা "অফার" পাঠায়
   (deliveryOffers-এর মতোই একই প্যাটার্ন)। Reject/timeout হলে পরের কাছের
   ড্রাইভারকে অটো পাঠানো হয়। */

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

  // 📏 Pickup→Drop-এর আসল রোড-ডিস্ট্যান্স দিয়ে ভাড়া রিফাইন করা হচ্ছে (ক্যাশ থাকায়
  // বারবার রিঅ্যাসাইনমেন্টেও অতিরিক্ত API কল লাগে না — একই রুট ২ ঘণ্টা ক্যাশ থাকে)
  const roadDist = await getRoadDistanceKm(tripData.pickupLat, tripData.pickupLng, tripData.dropLat, tripData.dropLng);
  const distanceKm = Math.round(roadDist.distanceKm * 10) / 10;
  const estimatedFare = Math.round((30 + distanceKm * 15) * 100) / 100; // বেস ৳ 30 + প্রতি কিমি ৳ 15
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
    distanceKm, estimatedFare, driverEarning, // রোড-ডিস্ট্যান্স অনুযায়ী রিফাইন করা মান — কাস্টমারের স্ক্রিনেও আপডেট হবে
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
    if (tripData.status !== "requested") return; // ইতিমধ্যে অন্য কেউ Accept করে নিয়েছে বা বাতিল হয়েছে

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
   দেওয়া হয় (স্টোরেজ খরচ বাঁচাতে ও ডেটাবেজ পরিষ্কার রাখতে)। */
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
   দিয়ে সব চ্যাটের messages সাব-কালেকশন একসাথে চেক করা হয়। */
exports.cleanupExpiredPrivacyMessages = onSchedule("every 1 minutes", async () => {
  const now = Timestamp.now();
  const expiredSnap = await db.collectionGroup("messages")
    .where("expiresAt", "<", now)
    .get();
  if (expiredSnap.empty) return;
  await Promise.all(expiredSnap.docs.map((doc) => doc.ref.delete()));
  console.log(`🔐 প্রাইভেসি মোডের ${expiredSnap.size}টা মেয়াদোত্তীর্ণ মেসেজ মুছে ফেলা হয়েছে`);
});
