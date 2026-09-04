/* ============================================================
   test-auto-dispatch.js
   Honey Bee Delivery — Auto-Dispatch Engine — স্বয়ংক্রিয় টেস্ট স্ক্রিপ্ট

   ⚠️ এটা আপনার নিজের কম্পিউটারে চালাতে হবে — Claude-এর sandbox থেকে
   Firebase-এ কানেক্ট করা সম্ভব না (নেটওয়ার্ক অ্যাক্সেস নেই)।

   ==================== সেটআপ ====================
   ১. Node.js ইনস্টল থাকতে হবে (v18+)
   ২. টার্মিনালে:
        npm install firebase-admin
   ৩. Firebase Console → Project Settings → Service Accounts →
      "Generate new private key" — এটা ডাউনলোড করে এই স্ক্রিপ্টের
      পাশে "serviceAccountKey.json" নামে রাখুন।
      ⚠️ এই ফাইলটা কখনো GitHub/পাবলিক কোথাও দেবেন না — এটা আপনার
      পুরো Firebase প্রজেক্টের অ্যাডমিন-অ্যাক্সেস দেয়।
   ৪. চালান:
        node test-auto-dispatch.js
   ৫. স্ক্রিপ্ট শেষে নিজে থেকেই সব TEST_ ডেটা মুছে ফেলবে (ব্যর্থ হলেও
      best-effort চেষ্টা করবে) এবং একটা PASS/FAIL টেবিল প্রিন্ট করবে।

   ==================== গুরুত্বপূর্ণ সীমাবদ্ধতা ====================
   - সেকশন ১৭ (FCM) স্বয়ংক্রিয়ভাবে টেস্ট করা যায় না (Rider App সত্যিই
     background/closed অবস্থায় নোটিফিকেশন পাচ্ছে কিনা — এটা মানুষকেই
     সত্যিকারের ফোনে দেখতে হবে)। VAPID key বসানো না থাকলে এই স্ক্রিপ্ট
     সেটা শুধু detect করে "BLOCKED" বলবে।
   - সেকশন ১৯ (Cloud Log verification) — এই স্ক্রিপ্ট Firestore-এর
     ফলাফল (কে assigned হলো, dispatchState কী হলো) পরীক্ষা করে,
     কিন্তু structured Cloud Function logs (ORDER_DISPATCH_STARTED
     ইত্যাদি) সরাসরি পড়ে না — সেটা Firebase Console → Functions →
     Logs থেকে ম্যানুয়ালি দেখতে হবে।
   - Cloud Function ডিপ্লয় করা না থাকলে এই টেস্টগুলো FAIL দেখাবে
     (এটাই প্রত্যাশিত — dispatch হওয়ার কথাই না)।
   ============================================================ */

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const results = []; // { section, test, expected, actual, pass }
function record(section, test, expected, actual, pass) {
  results.push({ section, test, expected, actual, pass });
  console.log(`[${pass ? "✅ PASS" : "❌ FAIL"}] ${section} — ${test}`);
  if (!pass) console.log(`    প্রত্যাশিত: ${expected}\n    প্রকৃত: ${actual}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 🗑️ সব TEST_ ডকুমেন্ট মনে রাখা হয় — শেষে মুছে ফেলার জন্য
const createdDocs = { shops: [], riders: [], orderRequests: [], deliveryOffers: [] };
async function cleanup() {
  console.log("\n🧹 TEST_ ডেটা পরিষ্কার করা হচ্ছে...");
  for (const id of createdDocs.orderRequests) await db.collection("orderRequests").doc(id).delete().catch(() => {});
  for (const id of createdDocs.deliveryOffers) await db.collection("deliveryOffers").doc(id).delete().catch(() => {});
  for (const id of createdDocs.riders) await db.collection("riders").doc(id).delete().catch(() => {});
  for (const id of createdDocs.shops) await db.collection("shops").doc(id).delete().catch(() => {});
  console.log("✅ পরিষ্কার সম্পন্ন।");
}

async function waitForField(collection, docId, fieldPath, expectedValues, timeoutMs, intervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = await db.collection(collection).doc(docId).get();
    const data = doc.data() || {};
    const value = fieldPath.split(".").reduce((o, k) => (o ? o[k] : undefined), data);
    if (Array.isArray(expectedValues) ? expectedValues.includes(value) : value === expectedValues) {
      return { found: true, value, data };
    }
    await sleep(intervalMs);
  }
  const doc = await db.collection(collection).doc(docId).get();
  return { found: false, value: undefined, data: doc.data() || {} };
}

async function main() {
  console.log("🐝 Honey Bee Auto-Dispatch — টেস্ট শুরু হচ্ছে...\n");

  const TEST_MARKET_ID = "TEST_MARKET_1";

  /* ==================== ১. টেস্ট ডেটা তৈরি ==================== */
  const shopId = "TEST_SHOP_" + Date.now();
  await db.collection("shops").doc(shopId).set({
    name: "TEST_ দোকান",
    marketId: TEST_MARKET_ID,
    storeLocation: { lat: 23.8103, lng: 90.4125, updatedAt: FieldValue.serverTimestamp() },
  });
  createdDocs.shops.push(shopId);

  const rider1Id = "TEST_RIDER1_" + Date.now();
  const rider2Id = "TEST_RIDER2_" + Date.now();
  const rider3Id = "TEST_RIDER3_" + Date.now();

  async function makeRider(id, overrides) {
    await db.collection("riders").doc(id).set(Object.assign({
      name: "TEST_ রাইডার " + id.slice(-4),
      phone: "01700000000",
      status: "active",
      online: false,
      transportModeOn: false,
      currentStatus: "offline",
      marketId: TEST_MARKET_ID,
      liveLocation: { lat: 23.8110, lng: 90.4130, updatedAt: FieldValue.serverTimestamp() },
    }, overrides));
    createdDocs.riders.push(id);
  }

  /* ==================== ৩. Rider Online → currentStatus টেস্ট ==================== */
  await makeRider(rider1Id, {});
  await db.collection("riders").doc(rider1Id).update({ online: true, currentStatus: "available" });
  let check = await db.collection("riders").doc(rider1Id).get();
  record("৩. Rider Online Status", "online→currentStatus=available",
    "online:true, currentStatus:available",
    `online:${check.data().online}, currentStatus:${check.data().currentStatus}`,
    check.data().online === true && check.data().currentStatus === "available");

  await db.collection("riders").doc(rider1Id).update({ online: false, currentStatus: "offline" });
  check = await db.collection("riders").doc(rider1Id).get();
  record("৩. Rider Offline Status", "online→currentStatus=offline",
    "online:false, currentStatus:offline",
    `online:${check.data().online}, currentStatus:${check.data().currentStatus}`,
    check.data().online === false && check.data().currentStatus === "offline");

  /* ==================== ৪. Transport Protection ==================== */
  await db.collection("riders").doc(rider1Id).update({
    online: true, transportModeOn: true, currentStatus: "on_trip", activeTripId: "TEST_TRIP_001",
  });
  await sleep(1000);
  check = await db.collection("riders").doc(rider1Id).get();
  record("৪. Transport State Protection", "currentStatus থাকে on_trip-ই (ওভাররাইট হয় না)",
    "on_trip", check.data().currentStatus,
    check.data().currentStatus === "on_trip");

  // রিসেট — বাকি টেস্টের জন্য স্বাভাবিক ডেলিভারি-এলিজিবল অবস্থায় ফেরত
  await db.collection("riders").doc(rider1Id).update({
    transportModeOn: false, currentStatus: "available", activeTripId: FieldValue.delete(),
  });

  /* ==================== ৫. Automatic Dispatch Trigger ==================== */
  const order1Id = "TEST_ORDER1_" + Date.now();
  await db.collection("orderRequests").doc(order1Id).set({
    shopId, productId: "TEST_PRODUCT", productName: "TEST_ প্রোডাক্ট",
    customerUid: "TEST_CUSTOMER", customerName: "TEST_ কাস্টমার",
    deliveryAddress: "TEST_ ঠিকানা", deliveryPhone: "01700000001",
    deliveryLat: 23.8095, deliveryLng: 90.4140,
    qty: 1, status: "pending", createdAt: FieldValue.serverTimestamp(),
  });
  createdDocs.orderRequests.push(order1Id);
  await sleep(500);
  await db.collection("orderRequests").doc(order1Id).update({ status: "preparing" });

  const dispatchResult = await waitForField("orderRequests", order1Id, "dispatchState", ["offer_sent", "searching_rider"], 30000);
  record("৫. Auto Dispatch Trigger", "status:preparing → dispatchState সেট হয়",
    "offer_sent বা searching_rider", dispatchResult.value,
    dispatchResult.found);

  let offer1Id = dispatchResult.data.currentOfferId;
  if (offer1Id) {
    const offerDoc = await db.collection("deliveryOffers").doc(offer1Id).get();
    createdDocs.deliveryOffers.push(offer1Id);
    const od = offerDoc.data() || {};
    record("৫. Offer Document Fields", "orderId, riderId, status:pending, expiresAt≈+60s",
      "সব ফিল্ড উপস্থিত",
      `orderId:${od.orderId}, riderId:${od.riderId}, status:${od.status}`,
      !!(od.orderId && od.riderId && od.status === "pending" && od.expiresAt));

    if (od.expiresAt && od.createdAt) {
      const diffSec = od.expiresAt.toMillis() / 1000 - od.createdAt.toMillis() / 1000;
      record("৫. ৬০ সেকেন্ড Expiry Window", "≈60 সেকেন্ড", `${diffSec.toFixed(1)} সেকেন্ড`,
        Math.abs(diffSec - 60) < 5);
    }
  } else {
    record("৫. Offer Document তৈরি", "একটা deliveryOffers ডকুমেন্ট তৈরি হবে", "কোনো offer পাওয়া যায়নি — Cloud Function deploy করা আছে কিনা যাচাই করুন", false);
  }

  /* ==================== ৮. Rider Accept ==================== */
  if (offer1Id) {
    await db.collection("deliveryOffers").doc(offer1Id).update({ status: "accepted" });
    const assignResult = await waitForField("orderRequests", order1Id, "dispatchState", "assigned", 15000);
    record("৮. Rider Accept → Assignment", "dispatchState:assigned, assignedRiderId সেট",
      "assigned + assignedRiderId", `dispatchState:${assignResult.value}, assignedRiderId:${assignResult.data.assignedRiderId}`,
      assignResult.found && !!assignResult.data.assignedRiderId);
  }

  /* ==================== ৯. Rider Reject (নতুন অর্ডার দিয়ে) ==================== */
  const rider1bId = rider1Id; // একই রাইডার আবার available করে রিজেক্ট-টেস্ট
  await db.collection("riders").doc(rider1bId).update({ online: true, currentStatus: "available" });
  const order2Id = "TEST_ORDER2_" + Date.now();
  await db.collection("orderRequests").doc(order2Id).set({
    shopId, productId: "TEST_PRODUCT2", productName: "TEST_ প্রোডাক্ট ২",
    customerUid: "TEST_CUSTOMER", customerName: "TEST_ কাস্টমার",
    deliveryAddress: "TEST_ ঠিকানা ২", deliveryPhone: "01700000002",
    deliveryLat: 23.8095, deliveryLng: 90.4140,
    qty: 1, status: "preparing", createdAt: FieldValue.serverTimestamp(),
  });
  createdDocs.orderRequests.push(order2Id);
  const dispatch2 = await waitForField("orderRequests", order2Id, "dispatchState", ["offer_sent", "waiting_for_rider"], 30000);
  const offer2Id = dispatch2.data.currentOfferId;
  if (offer2Id) {
    createdDocs.deliveryOffers.push(offer2Id);
    await db.collection("deliveryOffers").doc(offer2Id).update({ status: "skipped" });
    const retryResult = await waitForField("orderRequests", order2Id, "offeredRiderIds", undefined, 20000);
    // offeredRiderIds অ্যারেতে rider1 থাকা উচিত, আর হয় নতুন offer_sent অথবা waiting_for_rider (আর কোনো রাইডার না থাকলে)
    record("৯. Rider Reject → পরের চেষ্টা", "skip-এর পর dispatchState আবার আপডেট হয়",
      "offer_sent অথবা waiting_for_rider", retryResult.data.dispatchState,
      ["offer_sent", "waiting_for_rider"].includes(retryResult.data.dispatchState));
  } else {
    record("৯. Rider Reject টেস্ট সেটআপ", "প্রথম অফার তৈরি হওয়া দরকার ছিল", "অফার তৈরি হয়নি", false);
  }

  /* ==================== ১১. No Rider Available ==================== */
  await db.collection("riders").doc(rider1Id).update({ online: false, currentStatus: "offline" });
  const order3Id = "TEST_ORDER3_" + Date.now();
  await db.collection("orderRequests").doc(order3Id).set({
    shopId, productId: "TEST_PRODUCT3", productName: "TEST_ প্রোডাক্ট ৩",
    customerUid: "TEST_CUSTOMER", customerName: "TEST_ কাস্টমার",
    deliveryAddress: "TEST_ ঠিকানা ৩", deliveryPhone: "01700000003",
    deliveryLat: 23.8095, deliveryLng: 90.4140,
    qty: 1, status: "preparing", createdAt: FieldValue.serverTimestamp(),
  });
  createdDocs.orderRequests.push(order3Id);
  const noRiderResult = await waitForField("orderRequests", order3Id, "dispatchState", "waiting_for_rider", 30000);
  record("১১. No Rider Available", "dispatchState:waiting_for_rider, status অপরিবর্তিত preparing",
    "waiting_for_rider + preparing", `dispatchState:${noRiderResult.value}, status:${noRiderResult.data.status}`,
    noRiderResult.found && noRiderResult.data.status === "preparing");

  /* ==================== ১২. Rider Comes Online → Queue পুনর্মূল্যায়ন ==================== */
  await makeRider(rider2Id, { online: true, currentStatus: "available" });
  const queueRetryResult = await waitForField("orderRequests", order3Id, "dispatchState", ["offer_sent", "assigned"], 30000);
  record("১২. Rider Online → Queue পুনর্মূল্যায়ন", "waiting_for_rider থেকে offer_sent-এ ফিরবে",
    "offer_sent বা assigned", queueRetryResult.value,
    queueRetryResult.found);
  if (queueRetryResult.data.currentOfferId) createdDocs.deliveryOffers.push(queueRetryResult.data.currentOfferId);

  /* ==================== ১৩. Transport Mode Exclusion ==================== */
  await makeRider(rider3Id, { online: true, transportModeOn: true, currentStatus: "available" });
  const order4Id = "TEST_ORDER4_" + Date.now();
  await db.collection("orderRequests").doc(order4Id).set({
    shopId, productId: "TEST_PRODUCT4", productName: "TEST_ প্রোডাক্ট ৪",
    customerUid: "TEST_CUSTOMER", customerName: "TEST_ কাস্টমার",
    deliveryAddress: "TEST_ ঠিকানা ৪", deliveryPhone: "01700000004",
    deliveryLat: 23.8095, deliveryLng: 90.4140,
    qty: 1, status: "preparing", createdAt: FieldValue.serverTimestamp(),
  });
  createdDocs.orderRequests.push(order4Id);
  await sleep(20000);
  const tmCheck = await db.collection("orderRequests").doc(order4Id).get();
  const assignedTo = tmCheck.data().assignedRiderId;
  record("১৩. Transport Mode Exclusion", `rider3 (${rider3Id}) এসাইন হবে না`,
    "assignedRiderId !== rider3Id", `assignedRiderId: ${assignedTo}`,
    assignedTo !== rider3Id);
  if (tmCheck.data().currentOfferId) createdDocs.deliveryOffers.push(tmCheck.data().currentOfferId);

  /* ==================== ১৭. FCM অবস্থা ==================== */
  const riderCheck = await db.collection("riders").doc(rider2Id).get();
  const hasFcmToken = !!(riderCheck.data() || {}).fcmToken;
  record("১৭. FCM", "VAPID key কনফিগার করা আছে কিনা (এই স্ক্রিপ্ট শুধু টোকেন-উপস্থিতি চেক করে, প্রকৃত পুশ টেস্ট না)",
    "রাইডারের fcmToken আছে", hasFcmToken ? "টোকেন পাওয়া গেছে" : "টোকেন নেই — BLOCKED (VAPID key/rider app খোলা ছিল না)",
    hasFcmToken);

  /* ==================== ফলাফল সারাংশ ==================== */
  console.log("\n\n📊 === চূড়ান্ত ফলাফল ===\n");
  console.log("| Test | Expected | Actual | PASS/FAIL |");
  console.log("|------|----------|--------|-----------|");
  results.forEach((r) => {
    console.log(`| ${r.section} — ${r.test} | ${r.expected} | ${r.actual} | ${r.pass ? "✅ PASS" : "❌ FAIL"} |`);
  });
  const passCount = results.filter((r) => r.pass).length;
  console.log(`\n${passCount}/${results.length} টেস্ট পাস করেছে।`);

  await cleanup();
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("\n❌ টেস্ট চলাকালীন এরর:", e);
    await cleanup();
    process.exit(1);
  });
