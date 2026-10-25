/* 💳 ওয়ালেট (পয়েন্ট) — সব লেখা এখন সার্ভারে।
   আগে এজেন্ট/ড্রাইভারের ফোন সরাসরি wallets/ লিখত, তাই নিয়ম খোলা রাখতে
   হয়েছিল — যে-কেউ নিজের পয়েন্ট বাড়াতে বা অন্যের পয়েন্ট শূন্য করতে
   পারত। এখন firestore.rules-এ wallets শুধু পড়া যায়; যোগ/কাটা হয়
   এই দুই ফাংশন দিয়ে:
     • walletTopup      — শুধু এজেন্ট/সুপারঅ্যাডমিন পয়েন্ট যোগ করে
     • walletChargeRide — ড্রাইভার Pick Up করে ভাড়া লেখার পর যাত্রী নিজে
                          "রাজি" চাপলে তাঁর পয়েন্ট থেকে ড্রাইভারের কাছে যায়;
                          একবারই কাটা যায়।
   সীমা appConfig/wallet থেকে বদলানো যায়:
     { maxTopup: 50000, maxRideFare: 2000 } */
module.exports = function makeWallet({ db, FieldValue, onCall, HttpsError }) {

  async function limits() {
    try {
      const d = await db.collection("appConfig").doc("wallet").get();
      const c = d.exists ? d.data() : {};
      return {
        maxTopup: Number(c.maxTopup) > 0 ? Number(c.maxTopup) : 50000,
        maxRideFare: Number(c.maxRideFare) > 0 ? Number(c.maxRideFare) : 2000,
      };
    } catch (e) { return { maxTopup: 50000, maxRideFare: 2000 }; }
  }

  async function roleOf(uid) {
    const [sa, u] = await Promise.all([
      db.collection("superadmins").doc(uid).get(),
      db.collection("users").doc(uid).get(),
    ]);
    return { superadmin: sa.exists, role: u.exists ? (u.data().role || null) : null };
  }

  function needUser(request) {
    const a = request.auth;
    if (!a || !a.uid) throw new HttpsError("unauthenticated", "লগইন করুন।");
    if (a.token && a.token.firebase && a.token.firebase.sign_in_provider === "anonymous")
      throw new HttpsError("permission-denied", "অতিথি একাউন্ট দিয়ে হবে না।");
    return a.uid;
  }

  /* ➕ এজেন্ট টপ-আপ — {uid, amount, note} */
  const walletTopup = onCall(async (request) => {
    const me = needUser(request);
    const r = await roleOf(me);
    if (!r.superadmin && r.role !== "agent")
      throw new HttpsError("permission-denied", "শুধু এজেন্ট পয়েন্ট যোগ করতে পারেন।");
    const d = request.data || {};
    const uid = String(d.uid || "").trim();
    const amount = Math.round(Number(d.amount));
    const note = d.note ? String(d.note).slice(0, 200) : null;
    const lim = await limits();
    if (!uid || uid.length > 128 || uid.includes("/"))
      throw new HttpsError("invalid-argument", "ইউজার আইডি ঠিক নেই।");
    if (!(amount > 0) || amount > lim.maxTopup)
      throw new HttpsError("invalid-argument", `পরিমাণ ১ থেকে ${lim.maxTopup}-এর মধ্যে হতে হবে।`);

    const who = await db.collection("users").doc(me).get();
    const byName = (who.exists && who.data().name) || "এজেন্ট";
    const ref = db.collection("wallets").doc(uid);
    const balance = await db.runTransaction(async (t) => {
      const w = await t.get(ref);
      const bal = (w.exists ? Number(w.data().balance) || 0 : 0) + amount;
      t.set(ref, { balance: bal, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      t.set(ref.collection("transactions").doc(), {
        type: "topup", amount, note, byUid: me, byName,
        createdAt: FieldValue.serverTimestamp(),
      });
      return bal;
    });
    return { ok: true, balance };
  });

  /* 🚕 ভাড়া দেওয়া — যাত্রী নিজে "রাজি" চাপলে — {queueId, fare}
     ড্রাইভার Pick Up করে ভাড়া লেখেন; যাত্রীর ফোনে "Wallet থেকে দেবেন?"
     আসে। যাত্রী রাজি হলে তাঁর ফোন থেকেই এটা ডাকা হয়। তাই ড্রাইভার
     ইচ্ছেমতো বেশি ভাড়া লিখে পয়েন্ট কেটে নিতে পারেন না।
     শর্ত: যে ডাকছে সে-ই যাত্রী (owner_uid == user_id == নিজে), ডকটা
     PICKED_UP, যাত্রী যে ভাড়া দেখেছেন সেটাই ডকে আছে (মাঝপথে বদলায়নি),
     আগে কাটা হয়নি, Pick Up ৩০ মিনিটের মধ্যে, ভাড়া সীমার ভেতরে, আর
     যিনি Pick Up করেছেন তিনি সত্যিই ড্রাইভার/রাইডার। */
  const walletChargeRide = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const queueId = String(d.queueId || "").trim();
    const seenFare = Math.round(Number(d.fare) || 0);
    if (!queueId || queueId.includes("/"))
      throw new HttpsError("invalid-argument", "ট্রিপের তথ্য পাওয়া যায়নি।");

    const lim = await limits();
    const qRef = db.collection("passenger_waiting_queue").doc(queueId);
    const pre = await qRef.get();
    if (!pre.exists) return { success: false, reason: "not_found" };
    const driver = String(pre.data().picked_up_by || "");
    if (!driver || driver === me) return { success: false, reason: "no_driver" };
    const [r, td] = await Promise.all([roleOf(driver), db.collection("transportDrivers").doc(driver).get()]);
    if (!td.exists && r.role !== "rider" && r.role !== "transport_driver")
      return { success: false, reason: "no_driver" };

    return db.runTransaction(async (t) => {
      const q = await t.get(qRef);
      if (!q.exists) return { success: false, reason: "not_found" };
      const p = q.data();
      if (p.status !== "PICKED_UP" || p.picked_up_by !== driver)
        return { success: false, reason: "changed" };
      if (p.user_id !== me || p.owner_uid !== me) return { success: false, reason: "not_yours" };
      if (p.walletCharged) return { success: false, reason: "already" };
      if (p.fareDeclined) return { success: false, reason: "declined" };
      const fare = Math.round(Number(p.fare) || 0);
      if (!(fare > 0)) return { success: false, reason: "invalid_fare" };
      if (fare !== seenFare) return { success: false, reason: "fare_changed", fare };
      if (fare > lim.maxRideFare) return { success: false, reason: "fare_too_high", max: lim.maxRideFare };
      const at = p.picked_up_at && p.picked_up_at.toMillis ? p.picked_up_at.toMillis() : 0;
      if (!at || Date.now() - at > 30 * 60 * 1000) return { success: false, reason: "too_late" };

      const pRef = db.collection("wallets").doc(me);
      const dRef = db.collection("wallets").doc(driver);
      const [pw, dw] = await Promise.all([t.get(pRef), t.get(dRef)]);
      const pBal = pw.exists ? Number(pw.data().balance) || 0 : 0;
      if (pBal < fare) return { success: false, reason: "insufficient_balance", balance: pBal };
      const dBal = dw.exists ? Number(dw.data().balance) || 0 : 0;
      const now = FieldValue.serverTimestamp();

      t.set(pRef, { balance: pBal - fare, updatedAt: now }, { merge: true });
      t.set(pRef.collection("transactions").doc(), {
        type: "ride_payment", amount: -fare, note: "ট্রিপ ভাড়া", queueId, driverUid: driver, createdAt: now,
      });
      t.set(dRef, { balance: dBal + fare, updatedAt: now }, { merge: true });
      t.set(dRef.collection("transactions").doc(), {
        type: "ride_earning", amount: fare, note: "ট্রিপ আয়", queueId, passengerUid: me, createdAt: now,
      });
      t.update(qRef, { walletCharged: true, walletChargedAt: now });
      return { success: true, fare, balance: pBal - fare };
    });
  });

  return { walletTopup, walletChargeRide };
};
