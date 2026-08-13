/* ============================================================
   functions/index.js
   দোকান "ডেলিভারি ম্যান কে ডাকুন" বাটনে চাপ দিলে shops/{shopId}/deliveryCalls
   কালেকশনে একটা নতুন ডকুমেন্ট তৈরি হয় (ক্লায়েন্ট থেকে)। এই ফাংশনটা সেটা
   লক্ষ্য করে (trigger) সাথে সাথে ঐ দোকানের সব রেজিস্টার্ড ডেলিভারি-অ্যাপ
   ডিভাইসে পুশ নোটিফিকেশন পাঠিয়ে দেয়। এটা সার্ভারে চলে বলেই ব্যাকগ্রাউন্ডে/
   অ্যাপ বন্ধ থাকা অবস্থাতেও ডেলিভারি ম্যানের ফোনে নোটিফিকেশন পৌঁছায়।

   ডিপ্লয় করতে হবে — চ্যাট থেকে এটা সরাসরি Firebase-এ বসানো যায় না।
   নিচের DEPLOY-README.md ফাইলে ধাপে ধাপে নির্দেশনা আছে।
   ============================================================ */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

exports.onDeliveryCall = onDocumentCreated(
  "shops/{shopId}/deliveryCalls/{callId}",
  async (event) => {
    const shopId = event.params.shopId;

    // এই দোকানের সাথে যেসব ডেলিভারি-অ্যাপ ডিভাইস কানেক্টেড (FCM টোকেন) আছে
    const devicesSnap = await db
      .collection("shops").doc(shopId)
      .collection("deliveryDevices")
      .where("active", "==", true)
      .get();

    if (devicesSnap.empty) {
      console.log(`কোনো ডেলিভারি ডিভাইস রেজিস্টার্ড নেই — shopId: ${shopId}`);
      return;
    }

    const shopDoc = await db.collection("shops").doc(shopId).get();
    const shopName =
      (shopDoc.exists && (shopDoc.data().name || shopDoc.data().shopName)) ||
      "দোকান";

    const tokens = devicesSnap.docs.map((d) => d.id);

    const message = {
      notification: {
        title: `🔔 ${shopName} থেকে ডাকছে!`,
        body: "নতুন ডেলিভারি অর্ডার আছে — দোকানে যোগাযোগ করুন।",
      },
      data: {
        type: "delivery-call",
        shopId,
      },
      webpush: {
        fcmOptions: {
          // নিজের হোস্টিং ডোমেইন বসান, যেখানে delivery-man-app.html রাখা আছে
          link: "https://YOUR-DOMAIN-HERE/delivery-man-app.html",
        },
      },
      tokens,
    };

    const response = await getMessaging().sendEachForMulticast(message);
    console.log(
      `পাঠানো হয়েছে — সফল: ${response.successCount}, ব্যর্থ: ${response.failureCount}`
    );

    // যেসব টোকেন আর কার্যকর না (অ্যাপ আনইনস্টল/পুরনো), সেগুলো মুছে ফেলা
    const deadTokens = [];
    response.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered") {
          deadTokens.push(tokens[idx]);
        }
      }
    });
    await Promise.all(
      deadTokens.map((t) =>
        db
          .collection("shops").doc(shopId)
          .collection("deliveryDevices").doc(t)
          .delete()
      )
    );
  }
);
