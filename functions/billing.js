/* =====================================================================
   💰 Honey Bee — আয়ের পথ, ধাপ আয়-১: ভিত্তি
   ---------------------------------------------------------------------
   এখানে যা আছে (সব শুরুতে বন্ধ — কোনো দোকানে কিছু কাটে না):
     • billingConfig/main — সুপার এডমিনের সেটিংস: bKash নম্বর, যোগাযোগ,
       দেশ (BD ৳ / SA রিয়াল) × ব্যবসার ধরন অনুযায়ী দাম, ফ্রি পণ্যের সংখ্যা,
       প্রতিটা ব্যবসার আলাদা চালু/বন্ধ সুইচ। সবাই পড়তে পারে (দোকানকে দাম
       আর bKash নম্বর দেখাতে হবে), লেখে শুধু এই ফাংশন।
     • billing/{bizId} — প্রতিটা ব্যবসার ক্রেডিট (দোকান = shopId, দর্জি/
       রেস্টুরেন্ট/ড্রাইভার = নিজের uid)। ফোন থেকে কেউ বদলাতে পারে না।
     • billing/{bizId}/ledger — প্রতিটা যোগ/কাটার খাতা (কে, কখন, কত, কেন)।
     • billingDaily/{YYYY-MM-DD} — দিনের সারাংশ (বাংলাদেশ সময়): আসল আয়,
       দেওয়া ক্রেডিট (কেনা/উপহার আলাদা), খরচ হওয়া ক্রেডিট (বিক্রি/অর্ডার
       আলাদা)। আয়ের হিসাব পাতা (আয়-৮) মাসে ~৩০টা নথি পড়েই সব দেখাবে।
   পরের ধাপগুলো (রিচার্জ, প্রতি বিক্রিতে কাটা, অর্ডার-ফি…) সবাই
   billingApply() দিয়েই ক্রেডিট বদলাবে — হিসাব এক জায়গায় থাকে।
   ===================================================================== */
module.exports = function makeBilling({ db, FieldValue, Timestamp, onCall, HttpsError }) {

  const TYPES = ["shop", "tailor", "restaurant", "pharmacy", "driver"];
  const TYPE_BN = { shop: "দোকান (POS)", tailor: "সেলাই ঘর", restaurant: "রেস্টুরেন্ট", pharmacy: "ফার্মেসি", driver: "ট্রান্সপোর্ট ড্রাইভার" };
  const COUNTRIES = ["BD", "SA"];
  const PRICE_KEYS = ["perSale", "orderFee", "pkg6", "pkg12", "freeProducts"];

  const DEFAULT_PRICES = {
    BD: { perSale: 0.25, orderFee: 2, pkg6: 300, pkg12: 500, freeProducts: 10 },
    SA: { perSale: 0.05, orderFee: 0.5, pkg6: 30, pkg12: 50, freeProducts: 10 },
  };
  function defaults() {
    const prices = {};
    COUNTRIES.forEach((c) => { prices[c] = {}; TYPES.forEach((t) => { prices[c][t] = Object.assign({}, DEFAULT_PRICES[c]); }); });
    const types = {}; TYPES.forEach((t) => { types[t] = false; });
    return {
      enabled: false, // 🔒 সব বন্ধ — সুপার এডমিন চালু না করা পর্যন্ত কোথাও কিছু কাটে না
      types,
      pay: { bkash: "", bkashType: "personal", nagad: "", rocket: "", saMethod: "", saNumber: "", note: "" },
      contact: { phone: "", email: "" },
      minRecharge: { BD: 50, SA: 5 },
      giftDefault: { BD: 50, SA: 5 },
      prices,
      bigShopOrders: 10,     // মাসে এত অনলাইন অর্ডার এলে "বড় দোকান" হিসেবে জানানো (আয়-৭)
      orderTimeoutMin: 20,   // দোকান এত মিনিটে সাড়া না দিলে গ্রাহক অন্য দোকানে (আয়-৬)
    };
  }

  /* ---------- সেটিংস পড়া (৫ মিনিট মনে রাখা) ---------- */
  let __cfg = null, __cfgAt = 0;
  async function getConfig(fresh) {
    if (!fresh && __cfg && Date.now() - __cfgAt < 5 * 60 * 1000) return __cfg;
    const d = await db.collection("billingConfig").doc("main").get();
    __cfg = mergeDeep(defaults(), d.exists ? d.data() : {});
    __cfgAt = Date.now();
    return __cfg;
  }
  function mergeDeep(base, extra) {
    if (!extra || typeof extra !== "object") return base;
    Object.keys(extra).forEach((k) => {
      const v = extra[k];
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Timestamp) && base[k] && typeof base[k] === "object") base[k] = mergeDeep(base[k], v);
      else base[k] = v;
    });
    return base;
  }

  /* ---------- যাচাই ---------- */
  const s = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 80);
  const phoneOk = (v) => !v || /^[0-9+ \-]{6,20}$/.test(v);
  function num(v, min, max, label) {
    const n = Math.round(Number(v) * 100) / 100;
    if (!isFinite(n) || n < min || n > max) throw new HttpsError("invalid-argument", `${label} ঠিক নেই (${min}–${max})`);
    return n;
  }
  function cleanConfig(c) {
    c = c || {};
    const out = defaults();
    out.enabled = c.enabled === true;
    TYPES.forEach((t) => { out.types[t] = !!(c.types && c.types[t] === true); });
    const p = c.pay || {};
    out.pay = { bkash: s(p.bkash, 20), bkashType: p.bkashType === "merchant" ? "merchant" : (p.bkashType === "agent" ? "agent" : "personal"),
      nagad: s(p.nagad, 20), rocket: s(p.rocket, 20), saMethod: s(p.saMethod, 40), saNumber: s(p.saNumber, 40), note: s(p.note, 300) };
    ["bkash", "nagad", "rocket"].forEach((k) => { if (!phoneOk(out.pay[k])) throw new HttpsError("invalid-argument", k + " নম্বর ঠিক নেই"); });
    const ct = c.contact || {};
    out.contact = { phone: s(ct.phone, 20), email: s(ct.email, 80) };
    if (!phoneOk(out.contact.phone)) throw new HttpsError("invalid-argument", "যোগাযোগের ফোন নম্বর ঠিক নেই");
    if (out.contact.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contact.email)) throw new HttpsError("invalid-argument", "ইমেইল ঠিক নেই");
    COUNTRIES.forEach((cc) => {
      out.minRecharge[cc] = num((c.minRecharge || {})[cc] ?? out.minRecharge[cc], 0, 100000, "ন্যূনতম রিচার্জ");
      out.giftDefault[cc] = num((c.giftDefault || {})[cc] ?? out.giftDefault[cc], 0, 100000, "উপহার ক্রেডিট");
      TYPES.forEach((t) => {
        const src = ((c.prices || {})[cc] || {})[t] || {};
        PRICE_KEYS.forEach((k) => {
          const max = k === "freeProducts" ? 100000 : 1000000;
          out.prices[cc][t][k] = num(src[k] ?? out.prices[cc][t][k], 0, max, TYPE_BN[t] + " — " + k);
        });
        out.prices[cc][t].freeProducts = Math.round(out.prices[cc][t].freeProducts);
      });
    });
    out.bigShopOrders = Math.round(num(c.bigShopOrders ?? out.bigShopOrders, 1, 100000, "বড় দোকানের অর্ডার সংখ্যা"));
    out.orderTimeoutMin = Math.round(num(c.orderTimeoutMin ?? out.orderTimeoutMin, 5, 240, "অর্ডারে সাড়ার সময়"));
    return out;
  }

  /* ---------- দিনের তারিখ (বাংলাদেশ সময়) ---------- */
  const dayKey = (ms) => new Date((ms || Date.now()) + 6 * 3600000).toISOString().slice(0, 10);

  /* ---------- ক্রেডিট বদলানোর একমাত্র পথ ----------
     kind:
       "recharge"   — দোকান টাকা দিয়ে কিনল (আসল আয়; amount>0, money = হাতে আসা টাকা)
       "gift"       — 🎁 উপহার (আয় না)
       "correction" — সুপার এডমিনের সংশোধন (+/-)
       "sale"       — দোকানে বিক্রিতে কাটা (amount<0)        [আয়-৫]
       "order"      — অনলাইন অর্ডার গ্রহণে কাটা (amount<0)   [আয়-৬]
       "refund"     — অর্ডার-ফি ফেরত (amount>0)              [আয়-৬]
       "package"    — প্যাকেজ কেনা (credit বদলায় না; money = আয়)  [আয়-৪]
     allowNegative — বিক্রি ক্লাউডে দেরিতে জমা হলে ক্রেডিট একটু মাইনাসে যেতে পারে */
  const KINDS = ["recharge", "gift", "correction", "sale", "order", "refund", "package"];
  async function billingApply(o) {
    if (!KINDS.includes(o.kind)) throw new Error("billing kind ঠিক নেই: " + o.kind);
    const bizId = String(o.bizId || "");
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(bizId)) throw new HttpsError("invalid-argument", "ব্যবসার আইডি ঠিক নেই");
    const amount = Math.round(Number(o.amount || 0) * 100) / 100;
    const money = Math.round(Number(o.money || 0) * 100) / 100;
    const ref = db.collection("billing").doc(bizId);
    const day = dayKey();
    const dref = db.collection("billingDaily").doc(day);
    return db.runTransaction(async (t) => {
      const b = await t.get(ref);
      const cur = b.exists ? b.data() : {};
      const bal = Math.round((Number(cur.credit) || 0) * 100) / 100;
      const next = Math.round((bal + amount) * 100) / 100;
      if (amount < 0 && next < 0 && !o.allowNegative) return { ok: false, reason: "low_credit", credit: bal };
      // ধারাবাহিক নম্বর (একই সংখ্যা দুবার না): ref-এ আগে থেকে থাকলে বাদ
      if (o.dedupeKey) {
        const dk = await t.get(ref.collection("dedupe").doc(String(o.dedupeKey).slice(0, 140)));
        if (dk.exists) return { ok: false, reason: "duplicate", credit: bal };
        t.set(ref.collection("dedupe").doc(String(o.dedupeKey).slice(0, 140)), { at: FieldValue.serverTimestamp() });
      }
      const now = FieldValue.serverTimestamp();
      // ⚠️ set(..., {merge:true})-এ বিন্দু (".") দেওয়া নাম আলাদা ঘর ধরে না — তাই ভেতরের ঘরগুলো নেস্টেড অবজেক্টে
      const totals = { totals: { [o.kind]: FieldValue.increment(amount) } };
      if (money) totals.totals.money = FieldValue.increment(money);
      if (o.kind === "gift") totals.giftCredit = FieldValue.increment(amount);
      t.set(ref, Object.assign({
        bizId, bizType: TYPES.includes(o.bizType) ? o.bizType : (cur.bizType || "shop"),
        country: o.country === "SA" ? "SA" : (cur.country || "BD"),
        name: o.name ? s(o.name, 80) : (cur.name || ""),
        credit: next, updatedAt: now,
      }, b.exists ? {} : { createdAt: now }), { merge: true });
      t.set(ref, totals, { merge: true });
      t.set(ref.collection("ledger").doc(), {
        kind: o.kind, amount, money, balanceAfter: next, note: s(o.note, 200),
        ref: o.ref ? s(o.ref, 80) : null, byUid: o.byUid || null, byName: o.byName ? s(o.byName, 60) : null, at: now,
      });
      // 📊 দিনের সারাংশ
      const cc = o.country === "SA" ? "SA" : (cur.country || "BD");
      const inc = { day, updatedAt: now, [cc]: {} };
      const add = (k, v) => { if (v) inc[cc][k] = FieldValue.increment(v); };
      if (o.kind === "recharge") { add("income", money || amount); add("issuedPaid", amount); add("recharges", 1); }
      if (o.kind === "gift") { add("issuedGift", amount); add("gifts", 1); }
      if (o.kind === "correction") add("corrections", amount);
      if (o.kind === "sale") { add("spentSale", -amount); add("sales", 1); }
      if (o.kind === "order") { add("spentOrder", -amount); add("orders", 1); }
      if (o.kind === "refund") add("refunds", amount);
      if (o.kind === "package") { add("income", money); add("packages", 1); }
      t.set(dref, inc, { merge: true });
      return { ok: true, credit: next };
    });
  }

  /* ---------- সুপার এডমিন ---------- */
  async function needSuper(request) {
    const a = request.auth;
    if (!a || !a.uid) throw new HttpsError("unauthenticated", "লগইন করুন");
    const sa = await db.collection("superadmins").doc(a.uid).get();
    if (!sa.exists) throw new HttpsError("permission-denied", "শুধু সুপার এডমিন");
    return { uid: a.uid, name: (a.token && (a.token.name || a.token.email)) || "সুপার এডমিন" };
  }
  async function findBiz(bizId) {
    // নাম আর দেশ খুঁজে বের করা — কোন সংগ্রহে আছে দেখে ধরন ঠিক করা
    const tries = [["shops", "shop"], ["restaurants", "restaurant"], ["tailors", "tailor"], ["transportDrivers", "driver"]];
    for (const [col, type] of tries) {
      const d = await db.collection(col).doc(bizId).get();
      if (d.exists) {
        const x = d.data() || {};
        let t = type;
        if (col === "shops" && x.shopType === "pharmacy") t = "pharmacy";
        return { type: t, name: x.shopName || x.name || x.restaurantName || x.tailorName || x.fullName || "",
          country: (x.countryCode || x.country || "BD") === "SA" ? "SA" : "BD" };
      }
    }
    return null;
  }

  const billingAdmin = onCall(async (request) => {
    const me = await needSuper(request);
    const d = request.data || {};
    if (d.action === "getConfig") return { config: await getConfig(true) };
    if (d.action === "saveConfig") {
      const c = cleanConfig(d.config);
      c.updatedAt = FieldValue.serverTimestamp(); c.updatedBy = me.uid;
      await db.collection("billingConfig").doc("main").set(c);
      __cfg = null;
      await db.collection("billingAudit").add({ action: "saveConfig", byUid: me.uid, byName: me.name, enabled: c.enabled, types: c.types, at: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    if (d.action === "lookup") {
      const bizId = s(d.bizId, 128);
      const info = await findBiz(bizId);
      if (!info) throw new HttpsError("not-found", "এই আইডির কোনো ব্যবসা পাওয়া যায়নি");
      return { ok: true, info };
    }
    if (d.action === "adjust") {
      const bizId = s(d.bizId, 128);
      const kind = d.kind === "gift" ? "gift" : "correction";
      const amount = num(d.amount, -100000, 100000, "পরিমাণ");
      if (!amount) throw new HttpsError("invalid-argument", "পরিমাণ দিন");
      if (kind === "gift" && amount < 0) throw new HttpsError("invalid-argument", "উপহার মাইনাস হয় না");
      const info = await findBiz(bizId);
      if (!info) throw new HttpsError("not-found", "এই আইডির কোনো ব্যবসা পাওয়া যায়নি");
      if (kind === "gift" && d.once !== false) {
        const prev = await db.collection("billing").doc(bizId).get();
        if (prev.exists && Number(prev.data().giftCredit) > 0) throw new HttpsError("already-exists", "এই ব্যবসা আগেই উপহার ক্রেডিট পেয়েছে (একবারই দেওয়া যায়)");
      }
      const note = s(d.note, 200);
      if (kind === "correction" && note.length < 3) throw new HttpsError("invalid-argument", "সংশোধনের কারণ লিখুন");
      const r = await billingApply({ bizId, bizType: info.type, country: info.country, name: info.name, kind, amount,
        note: note || (kind === "gift" ? "🎁 Honey Bee-র উপহার" : ""), byUid: me.uid, byName: me.name, allowNegative: true });
      return Object.assign({ info }, r);
    }
    throw new HttpsError("invalid-argument", "অজানা কাজ");
  });

  return { billingAdmin, _billing: { billingApply, getConfig, defaults, cleanConfig, TYPES, dayKey } };
};
