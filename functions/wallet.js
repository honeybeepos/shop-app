/* 💳 ওয়ালেট (পয়েন্ট) — সব লেখা এখন সার্ভারে।
   আগে এজেন্ট/ড্রাইভারের ফোন সরাসরি wallets/ লিখত, তাই নিয়ম খোলা রাখতে
   হয়েছিল — যে-কেউ নিজের পয়েন্ট বাড়াতে বা অন্যের পয়েন্ট শূন্য করতে
   পারত। এখন firestore.rules-এ wallets শুধু পড়া যায়; যোগ/কাটা হয়
   এই দুই ফাংশন দিয়ে:
     • walletTopup      — শুধু এজেন্ট/সুপারঅ্যাডমিন পয়েন্ট যোগ করে
     • walletChargeRide — ড্রাইভার/রাইডার যাত্রীকে Pick Up করার পর
                          ভাড়া কাটে; ভাড়া নেওয়া হয় সার্ভারে রাখা
                          passenger_waiting_queue ডক থেকে, একবারই কাটা যায়।
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

  /* 🚕 ভাড়া কাটা — {queueId}
     শর্ত: ডকটা PICKED_UP, picked_up_by == যে ডাকছে, যাত্রী নিজের লগইন
     দিয়েই অপেক্ষার তালিকায় উঠেছিলেন (owner_uid == user_id), আগে কাটা
     হয়নি, Pick Up ৩০ মিনিটের মধ্যে, আর ভাড়া সীমার ভেতরে। */
  const walletChargeRide = onCall(async (request) => {
    const me = needUser(request);
    const queueId = String((request.data || {}).queueId || "").trim();
    if (!queueId || queueId.includes("/"))
      throw new HttpsError("invalid-argument", "যাত্রীর তথ্য পাওয়া যায়নি।");

    const [r, td] = await Promise.all([
      roleOf(me),
      db.collection("transportDrivers").doc(me).get(),
    ]);
    if (!r.superadmin && !td.exists && r.role !== "rider" && r.role !== "transport_driver")
      throw new HttpsError("permission-denied", "শুধু ড্রাইভার/রাইডার ভাড়া কাটতে পারেন।");

    const lim = await limits();
    const qRef = db.collection("passenger_waiting_queue").doc(queueId);

    return db.runTransaction(async (t) => {
      const q = await t.get(qRef);
      if (!q.exists) return { success: false, reason: "not_found" };
      const p = q.data();
      if (p.status !== "PICKED_UP" || p.picked_up_by !== me)
        return { success: false, reason: "not_yours" };
      if (p.walletCharged) return { success: false, reason: "already" };
      const passenger = String(p.user_id || "");
      if (!passenger || passenger.startsWith("guest_") || !p.owner_uid || p.owner_uid !== passenger)
        return { success: false, reason: "no_wallet" };
      if (passenger === me) return { success: false, reason: "self" };
      const fare = Math.round(Number(p.fare) || 0);
      if (!(fare > 0)) return { success: false, reason: "invalid_fare" };
      if (fare > lim.maxRideFare) return { success: false, reason: "fare_too_high", max: lim.maxRideFare };
      const at = p.picked_up_at && p.picked_up_at.toMillis ? p.picked_up_at.toMillis() : 0;
      if (!at || Date.now() - at > 30 * 60 * 1000) return { success: false, reason: "too_late" };

      const pRef = db.collection("wallets").doc(passenger);
      const dRef = db.collection("wallets").doc(me);
      const [pw, dw] = await Promise.all([t.get(pRef), t.get(dRef)]);
      const pBal = pw.exists ? Number(pw.data().balance) || 0 : 0;
      if (pBal < fare) return { success: false, reason: "insufficient_balance" };
      const dBal = dw.exists ? Number(dw.data().balance) || 0 : 0;
      const now = FieldValue.serverTimestamp();

      t.set(pRef, { balance: pBal - fare, updatedAt: now }, { merge: true });
      t.set(pRef.collection("transactions").doc(), {
        type: "ride_payment", amount: -fare, note: "ট্রিপ ভাড়া", queueId, driverUid: me, createdAt: now,
      });
      t.set(dRef, { balance: dBal + fare, updatedAt: now }, { merge: true });
      t.set(dRef.collection("transactions").doc(), {
        type: "ride_earning", amount: fare, note: "ট্রিপ আয়", queueId, passengerUid: passenger, createdAt: now,
      });
      t.update(qRef, { walletCharged: true, walletChargedAt: now });
      return { success: true, fare };
    });
  });

  return { walletTopup, walletChargeRide };
};
