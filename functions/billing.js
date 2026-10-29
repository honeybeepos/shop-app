/* =====================================================================
   💰 Honey Bee — আয়ের পথ (⭐ নতুন মডেল, ২৮ অক্টোবর ২০২৬)
   ---------------------------------------------------------------------
   এক বাক্যে: দোকানে বিক্রির জন্য সাবস্ক্রিপশন নিন, না নিলে প্রতি
   বিক্রিতে ক্রেডিট কাটবে; অনলাইন অর্ডার গ্রহণে সবসময় ক্রেডিট কাটবে।
   শুধু ডেলিভারিম্যান ফ্রি। সব শুরুতে বন্ধ — সুপার এডমিন মূল সুইচ আর
   ব্যবসার ধরনের সুইচ চালু না করা পর্যন্ত কোথাও কিছু কাটে না।

   টাকার পথ:
     সুপার এডমিন ──(এজেন্ট আগে টাকা দেন; আইডিতে সরাসরি স্টক)──▶ এজেন্ট
     এজেন্ট ──(সরাসরি দোকানের আইডিতে, বা একবারের লাইসেন্স কি)──▶ দোকান
   আসল আয় = এজেন্টের কাছ থেকে পাওয়া টাকা (সুপার এডমিন স্টক দেওয়ার সময় লেখেন)।

   Firestore (সব লেখা শুধু সার্ভারে):
     billingConfig/main            সেটিংস (লগইন করা সবাই পড়ে)
     billing/{bizId}               ব্যবসার ক্রেডিট, গিফট, সাবস্ক্রিপশন
       /ledger                     প্রতিটা যোগ/কাটা
       /dedupe                     একই বিক্রি/অর্ডার দুবার না কাটার চিহ্ন
     agentStock/{agentUid}         এজেন্টের স্টক (ক্রেডিট + মাস অনুযায়ী সাবস্ক্রিপশন)
       /ledger                     স্টক আসা/দেওয়া
       /keys                       এজেন্টের বানানো কি (পুরো কোড — শুধু এজেন্ট আর সুপার এডমিন দেখেন)
     licenseKeys/{sha256}          কি যাচাইয়ের নথি (কেউ পড়তে পারে না)
     giftDevices/{sha256}          কোন ফোন/কম্পিউটার আগেই গিফট পেয়েছে
     billingDaily/{YYYY-MM-DD}     দিনের সারাংশ (বাংলাদেশ সময়)
     billingAudit                  সুপার এডমিনের কাজের খাতা
   ===================================================================== */
const crypto = require("crypto");

module.exports = function makeBilling({ db, FieldValue, Timestamp, onCall, HttpsError, onDocumentCreated, onDocumentWritten }) {

  const TYPES = ["shop", "pharmacy", "tailor", "restaurant", "driver"];
  const TYPE_BN = { shop: "দোকান", pharmacy: "ফার্মেসি", tailor: "সেলাই ঘর", restaurant: "রেস্টুরেন্ট", driver: "ট্রান্সপোর্ট" };
  const COUNTRIES = ["BD", "SA"];
  const MONTHS = [1, 3, 6, 12];
  const SUB_ONLY = ["driver", "tailor"]; // 🚑🧵 শুধু সাবস্ক্রিপশন — প্রতি কাজে ক্রেডিট কাটে না
  const mk = (m) => "m" + m;

  function defaults() {
    const types = {}; TYPES.forEach((t) => { types[t] = false; });
    return {
      enabled: false, // 🔒 মূল সুইচ
      types,
      prices: {
        BD: { perSale: 0.25, orderFee: 2, sub: { m1: 100, m3: 280, m6: 500, m12: 900 }, agentSub: { m1: 80, m3: 230, m6: 420, m12: 750 }, agentCreditPct: 90 },
        SA: { perSale: 0.05, orderFee: 0.5, sub: { m1: 10, m3: 28, m6: 50, m12: 90 }, agentSub: { m1: 8, m3: 23, m6: 42, m12: 75 }, agentCreditPct: 90 },
      },
      gift: { on: false, credit: { BD: 50, SA: 5 }, dailyMax: 20 },
      pay: { bkash: "", bkashType: "personal", nagad: "", rocket: "", saMethod: "", saNumber: "", note: "" },
      contact: { phone: "", email: "" },
      orderTimeoutMin: 20,
    };
  }

  /* ---------- সেটিংস ---------- */
  let __cfg = null, __cfgAt = 0;
  async function getConfig(fresh) {
    if (!fresh && __cfg && Date.now() - __cfgAt < 2 * 60 * 1000) return __cfg;
    const [d, pv] = await Promise.all([db.collection("billingConfig").doc("main").get(), db.collection("billingConfig").doc("private").get()]);
    __cfg = mergeDeep(mergeDeep(defaults(), d.exists ? d.data() : {}), pv.exists ? pv.data() : {});
    __cfgAt = Date.now();
    return __cfg;
  }
  function mergeDeep(base, extra) {
    if (!extra || typeof extra !== "object") return base;
    Object.keys(extra).forEach((k) => {
      const v = extra[k];
      if (v && typeof v === "object" && !Array.isArray(v) && typeof v.toMillis !== "function" && base[k] && typeof base[k] === "object") base[k] = mergeDeep(base[k], v);
      else base[k] = v;
    });
    return base;
  }
  const feeOn = (cfg, type) => !!(cfg.enabled && cfg.types && cfg.types[type]);

  const s = (v, max) => String(v == null ? "" : v).trim().slice(0, max || 80);
  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const phoneOk = (v) => !v || /^[0-9+ \-]{6,20}$/.test(v);
  function num(v, min, max, label) {
    const n = r2(v);
    if (!isFinite(Number(v)) || n < min || n > max) throw new HttpsError("invalid-argument", `${label} ঠিক নেই (${min}–${max})`);
    return n;
  }
  function cleanConfig(c) {
    c = c || {};
    const out = defaults();
    out.enabled = c.enabled === true;
    TYPES.forEach((t) => { out.types[t] = !!(c.types && c.types[t] === true); });
    COUNTRIES.forEach((cc) => {
      const src = (c.prices || {})[cc] || {}, o = out.prices[cc];
      o.perSale = num(src.perSale ?? o.perSale, 0, 10000, "প্রতি বিক্রিতে");
      o.orderFee = num(src.orderFee ?? o.orderFee, 0, 10000, "প্রতি অর্ডারে");
      o.agentCreditPct = num(src.agentCreditPct ?? o.agentCreditPct, 1, 100, "এজেন্টের ক্রেডিট দাম (%)");
      MONTHS.forEach((m) => {
        o.sub[mk(m)] = num(((src.sub || {})[mk(m)]) ?? o.sub[mk(m)], 0, 1000000, `${m} মাসের দাম`);
        o.agentSub[mk(m)] = num(((src.agentSub || {})[mk(m)]) ?? o.agentSub[mk(m)], 0, 1000000, `${m} মাসের এজেন্ট দাম`);
        if (o.agentSub[mk(m)] > o.sub[mk(m)]) throw new HttpsError("invalid-argument", `${m} মাস: এজেন্টের দাম খুচরা দামের চেয়ে বেশি হতে পারে না`);
      });
    });
    const g = c.gift || {};
    out.gift.on = g.on === true;
    COUNTRIES.forEach((cc) => { out.gift.credit[cc] = num(((g.credit || {})[cc]) ?? out.gift.credit[cc], 0, 100000, "গিফট ক্রেডিট"); });
    out.gift.dailyMax = Math.round(num(g.dailyMax ?? out.gift.dailyMax, 0, 100000, "দিনে কয়টা গিফট"));
    const p = c.pay || {};
    out.pay = { bkash: s(p.bkash, 20), bkashType: ["merchant", "agent"].includes(p.bkashType) ? p.bkashType : "personal",
      nagad: s(p.nagad, 20), rocket: s(p.rocket, 20), saMethod: s(p.saMethod, 40), saNumber: s(p.saNumber, 40), note: s(p.note, 300) };
    ["bkash", "nagad", "rocket"].forEach((k) => { if (!phoneOk(out.pay[k])) throw new HttpsError("invalid-argument", k + " নম্বর ঠিক নেই"); });
    const ct = c.contact || {};
    out.contact = { phone: s(ct.phone, 20), email: s(ct.email, 80) };
    if (!phoneOk(out.contact.phone)) throw new HttpsError("invalid-argument", "যোগাযোগের ফোন নম্বর ঠিক নেই");
    if (out.contact.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contact.email)) throw new HttpsError("invalid-argument", "ইমেইল ঠিক নেই");
    out.orderTimeoutMin = Math.round(num(c.orderTimeoutMin ?? out.orderTimeoutMin, 5, 240, "অর্ডারে সাড়ার সময়"));
    return out;
  }

  const dayKey = (ms) => new Date((ms || Date.now()) + 6 * 3600000).toISOString().slice(0, 10);
  const sha = (x) => crypto.createHash("sha256").update(String(x)).digest("hex");
  const tsMs = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : 0);
  const subActive = (b, at) => tsMs(b && b.sub && b.sub.until) > (at || Date.now());

  /* ---------- ব্যবসা চেনা ---------- */
  const BIZ_COLS = [["shops", "shop"], ["restaurants", "restaurant"], ["tailors", "tailor"], ["transportDrivers", "driver"]];
  async function findBiz(bizId, tx) {
    for (const [col, type] of BIZ_COLS) {
      const ref = db.collection(col).doc(bizId);
      const d = tx ? await tx.get(ref) : await ref.get();
      if (d.exists) {
        const x = d.data() || {};
        const t = col === "shops" && x.shopType === "pharmacy" ? "pharmacy" : type;
        return { id: bizId, col, type: t, name: x.shopName || x.name || x.fullName || "",
          phone: x.phone || x.ownerPhone || "", marketId: x.marketId || null,
          agentUid: x.assignedAgentId || null, country: (x.countryCode || x.country || "BD") === "SA" ? "SA" : "BD",
          onlineOrdersOff: x.onlineOrdersOff === true };
      }
    }
    return null;
  }
  // লগইন করা মানুষের ব্যবসা কোনটা (দোকানের সাব-ইউজারও নিজের দোকান পান)
  async function myBizId(uid) {
    const u = await db.collection("users").doc(uid).get();
    const x = u.exists ? u.data() : {};
    if (x.shopId) return x.shopId;
    return uid;
  }
  async function agentContact(biz) {
    let id = biz.agentUid;
    if (!id && biz.marketId) {
      const q = await db.collection("agents").where("marketId", "==", biz.marketId).where("status", "==", "active").limit(1).get();
      if (!q.empty) id = q.docs[0].id;
    }
    if (!id) return null;
    const a = await db.collection("agents").doc(id).get();
    if (!a.exists) return null;
    const x = a.data();
    return { uid: id, name: x.name || "এজেন্ট", phone: x.phone || "", whatsapp: x.whatsapp || x.phone || "" };
  }

  /* ---------- ক্রেডিট/সাবস্ক্রিপশন বদলানোর একমাত্র পথ ----------
     kind (ব্যবসার খাতায়):
       agent   — এজেন্ট সরাসরি দিলেন (+ক্রেডিট)     key   — কি বসিয়ে (+ক্রেডিট বা মাস)
       gift    — 🎁 গিফট (+)                         correction — সুপার এডমিনের সংশোধন (+/−)
       sale    — দোকানে বিক্রিতে কাটা (−)            order — অনলাইন অর্ডার গ্রহণে কাটা (−)
       refund  — ফেরত (+)                            sub   — সাবস্ক্রিপশন যোগ (months; ক্রেডিট বদলায় না)
     পড়া আর লেখা আলাদা — যাতে এজেন্টের স্টক কমানোর সাথে একই লেনদেনে চলে। */
  const KINDS = ["agent", "key", "gift", "correction", "sale", "order", "refund", "sub"];
  async function readBiz(t, bizId, dedupeKey) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(bizId || ""))) throw new HttpsError("invalid-argument", "ব্যবসার আইডি ঠিক নেই");
    const ref = db.collection("billing").doc(bizId);
    const b = await t.get(ref);
    let dup = false, dref = null;
    if (dedupeKey) {
      dref = ref.collection("dedupe").doc(sha(dedupeKey).slice(0, 40));
      dup = (await t.get(dref)).exists;
    }
    return { ref, exists: b.exists, cur: b.exists ? b.data() : {}, dup, dref };
  }
  function writeBiz(t, ctx, o) {
    if (!KINDS.includes(o.kind)) throw new Error("billing kind ঠিক নেই: " + o.kind);
    const cur = ctx.cur;
    const amount = r2(o.amount);
    const bal = r2(cur.credit);
    const next = r2(bal + amount);
    const now = FieldValue.serverTimestamp();
    const cc = o.country === "SA" ? "SA" : (cur.country || "BD");
    const base = {
      bizId: ctx.ref.id, bizType: TYPES.includes(o.bizType) ? o.bizType : (cur.bizType || "shop"),
      country: cc, name: o.name ? s(o.name, 80) : (cur.name || ""), credit: next, updatedAt: now,
      totals: { [o.kind]: FieldValue.increment(amount) },
    };
    if (o.agentUid) base.agentUid = o.agentUid;
    if (!ctx.exists) { base.createdAt = now; base.chargeFrom = Timestamp.now(); }
    if (o.kind === "gift") { base.giftCredit = FieldValue.increment(amount); base.giftGiven = true; base.giftAt = now; }
    let untilMs = null;
    if (o.months) {
      const from = Math.max(Date.now(), tsMs(cur.sub && cur.sub.until));
      const d = new Date(from); d.setMonth(d.getMonth() + Number(o.months));
      untilMs = d.getTime();
      base.sub = { until: Timestamp.fromMillis(untilMs), months: Number(o.months), lastAt: now };
      // 🧵 দর্জির সাবস্ক্রিপশন বাজারে দেখা যায় (কার ডিজাইন/নম্বর দেখাবে) — দর্জি নিজে বদলাতে পারেন না (rules)
      if ((o.bizType || cur.bizType) === "tailor") t.set(db.collection("tailors").doc(ctx.ref.id), { hbSubUntil: Timestamp.fromMillis(untilMs) }, { merge: true });
    }
    t.set(ctx.ref, base, { merge: true });
    if (ctx.dref) t.set(ctx.dref, { at: now, kind: o.kind });
    t.set(ctx.ref.collection("ledger").doc(), {
      kind: o.kind, amount, months: o.months || null, balanceAfter: next, subUntil: untilMs ? Timestamp.fromMillis(untilMs) : null,
      note: s(o.note, 200), ref: o.ref ? s(o.ref, 80) : null,
      byUid: o.byUid || null, byName: o.byName ? s(o.byName, 60) : null, at: now,
    });
    const inc = { day: dayKey(), updatedAt: now, [cc]: {} };
    const add = (k, v) => { if (v) inc[cc][k] = FieldValue.increment(v); };
    if (o.kind === "agent" || o.kind === "key") { add("creditOut", amount > 0 ? amount : 0); if (o.months) add("subsOut", 1); add(o.kind === "key" ? "keysUsed" : "agentGives", 1); }
    if (o.kind === "gift") { add("issuedGift", amount); add("gifts", 1); }
    if (o.kind === "correction") add("corrections", amount);
    if (o.kind === "sale") { add("spentSale", -amount); add("sales", 1); }
    if (o.kind === "order") { add("spentOrder", -amount); add("orders", 1); }
    if (o.kind === "refund") add("refunds", amount);
    if (o.kind === "sub") add("subsOut", 1);
    t.set(db.collection("billingDaily").doc(dayKey()), inc, { merge: true });
    return { credit: next, subUntil: untilMs };
  }
  async function billingApply(o) {
    return db.runTransaction(async (t) => {
      const ctx = await readBiz(t, o.bizId, o.dedupeKey);
      if (ctx.dup) return { ok: false, reason: "duplicate", credit: r2(ctx.cur.credit) };
      const next = r2(r2(ctx.cur.credit) + r2(o.amount));
      if (r2(o.amount) < 0 && next < 0 && !o.allowNegative) return { ok: false, reason: "low_credit", credit: r2(ctx.cur.credit) };
      return Object.assign({ ok: true }, writeBiz(t, ctx, o));
    });
  }

  /* ---------- কে ---------- */
  function needUser(request) {
    const a = request.auth;
    if (!a || !a.uid) throw new HttpsError("unauthenticated", "লগইন করুন");
    if (a.token && a.token.firebase && a.token.firebase.sign_in_provider === "anonymous") throw new HttpsError("unauthenticated", "লগইন করুন");
    return { uid: a.uid, name: (a.token && (a.token.name || a.token.email)) || "" };
  }
  async function needSuper(request) {
    const me = needUser(request);
    const sa = await db.collection("superadmins").doc(me.uid).get();
    if (!sa.exists) throw new HttpsError("permission-denied", "শুধু সুপার এডমিন");
    return Object.assign(me, { name: me.name || "সুপার এডমিন" });
  }
  async function needAgent(request) {
    const me = needUser(request);
    const a = await db.collection("agents").doc(me.uid).get();
    if (!a.exists || a.data().status === "blocked") throw new HttpsError("permission-denied", "শুধু এজেন্ট");
    return Object.assign(me, { name: a.data().name || "এজেন্ট", marketId: a.data().marketId || null });
  }
  const agentOwns = (agent, biz) => biz && (biz.agentUid === agent.uid || (!biz.agentUid && biz.marketId && biz.marketId === agent.marketId));

  /* ---------- লাইসেন্স কি ---------- */
  const KEY_ABC = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // ০/O, ১/I গুলিয়ে যায় বলে বাদ
  function newKey() {
    const b = crypto.randomBytes(12);
    let k = ""; for (let i = 0; i < 12; i++) k += KEY_ABC[b[i] % 32];
    return "HB-" + k.slice(0, 4) + "-" + k.slice(4, 8) + "-" + k.slice(8, 12);
  }
  const normKey = (k) => String(k || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^HB/, "");

  /* =================== 👑 সুপার এডমিন =================== */
  const billingAdmin = onCall(async (request) => {
    const me = await needSuper(request);
    const d = request.data || {};
    const audit = (action, extra) => db.collection("billingAudit").add(Object.assign({ action, byUid: me.uid, byName: me.name, at: FieldValue.serverTimestamp() }, extra || {}));

    if (d.action === "getConfig") return { config: await getConfig(true) };
    if (d.action === "saveConfig") {
      const c = cleanConfig(d.config);
      c.updatedAt = FieldValue.serverTimestamp(); c.updatedBy = me.uid;
      // 🔒 সুপার এডমিনের bKash/ফোন আলাদা নথিতে — দোকানদার/গ্রাহক পড়তে পারেন না, শুধু এজেন্ট
      const priv = { pay: c.pay, contact: c.contact, updatedAt: c.updatedAt };
      delete c.pay; delete c.contact;
      await Promise.all([db.collection("billingConfig").doc("main").set(c), db.collection("billingConfig").doc("private").set(priv)]);
      __cfg = null;
      await audit("saveConfig", { enabled: c.enabled, types: c.types, giftOn: c.gift.on });
      return { ok: true };
    }
    if (d.action === "lookup") {
      const biz = await findBiz(s(d.bizId, 128));
      if (!biz) throw new HttpsError("not-found", "এই আইডির কোনো ব্যবসা পাওয়া যায়নি");
      return { ok: true, info: biz };
    }
    // ✏️ ব্যবসায় সরাসরি: সংশোধন (+/−), গিফট, মাস যোগ
    if (d.action === "adjust") {
      const bizId = s(d.bizId, 128);
      const biz = await findBiz(bizId);
      if (!biz) throw new HttpsError("not-found", "এই আইডির কোনো ব্যবসা পাওয়া যায়নি");
      const kind = ["gift", "sub"].includes(d.kind) ? d.kind : "correction";
      const note = s(d.note, 200);
      const o = { bizId, bizType: biz.type, country: biz.country, name: biz.name, agentUid: biz.agentUid, kind, byUid: me.uid, byName: me.name, allowNegative: true, amount: 0 };
      if (kind === "sub") {
        o.months = Number(d.months); if (!MONTHS.includes(o.months)) throw new HttpsError("invalid-argument", "মাস ১/৩/৬/১২");
        o.note = note || "সুপার এডমিন দিয়েছেন";
      } else {
        o.amount = num(d.amount, -100000, 100000, "পরিমাণ");
        if (!o.amount) throw new HttpsError("invalid-argument", "পরিমাণ দিন");
        if (kind === "gift") {
          if (o.amount < 0) throw new HttpsError("invalid-argument", "গিফট মাইনাস হয় না");
          const prev = await db.collection("billing").doc(bizId).get();
          if (prev.exists && prev.data().giftGiven) throw new HttpsError("already-exists", "এই ব্যবসা আগেই গিফট পেয়েছে (একবারই)");
          o.note = note || "🎁 Honey Bee-র উপহার";
        } else {
          if (note.length < 3) throw new HttpsError("invalid-argument", "সংশোধনের কারণ লিখুন");
          o.note = note;
        }
      }
      const r = await billingApply(o);
      await audit("adjust", { bizId, kind, amount: o.amount, months: o.months || null, note: o.note });
      return Object.assign({ info: biz }, r);
    }
    // ↩️ অনলাইন অর্ডারের ফি ফেরত — ভুয়া অর্ডার বা গ্রাহকের দোষে বাতিল হলে (একটা খাতা-লাইনে একবারই)
    if (d.action === "refundOrder") {
      const bizId = s(d.bizId, 128), ledgerId = s(d.ledgerId, 64);
      const le = await db.collection("billing").doc(bizId).collection("ledger").doc(ledgerId).get();
      if (!le.exists || le.data().kind !== "order") throw new HttpsError("not-found", "এটা অনলাইন অর্ডারের ফি নয়");
      const amt = Math.abs(r2(le.data().amount));
      const note = s(d.note, 120) || "ভুয়া/বাতিল অর্ডার";
      const r = await billingApply({ bizId, kind: "refund", amount: amt, dedupeKey: "refund:" + ledgerId, ref: le.data().ref || null,
        note: "↩️ ফেরত — " + (le.data().note || "অনলাইন অর্ডার") + " (" + note + ")", byUid: me.uid, byName: me.name });
      if (!r.ok && r.reason === "duplicate") throw new HttpsError("already-exists", "এই অর্ডারের ফি আগেই ফেরত দেওয়া হয়েছে");
      await audit("refundOrder", { bizId, ledgerId, amount: amt, note });
      return r;
    }
    // 🎁 গিফট বাতিল — বাকি ক্রেডিট থেকে গিফটের অংশ সরানো
    if (d.action === "giftRevoke") {
      const bizId = s(d.bizId, 128);
      const b = await db.collection("billing").doc(bizId).get();
      if (!b.exists || !b.data().giftGiven) throw new HttpsError("not-found", "এই ব্যবসা গিফট পায়নি");
      const take = Math.min(r2(b.data().credit), r2(b.data().giftCredit));
      if (take <= 0) return { ok: true, credit: r2(b.data().credit), note: "গিফটের ক্রেডিট আগেই খরচ হয়ে গেছে" };
      const r = await billingApply({ bizId, kind: "correction", amount: -take, note: "🎁 গিফট বাতিল", byUid: me.uid, byName: me.name });
      await audit("giftRevoke", { bizId, amount: take });
      return r;
    }
    // 🔌 অনলাইন অর্ডার চালু/বন্ধ (এক ক্লিক)
    if (d.action === "onlineToggle") {
      const biz = await findBiz(s(d.bizId, 128));
      if (!biz) throw new HttpsError("not-found", "ব্যবসা পাওয়া যায়নি");
      await db.collection(biz.col).doc(biz.id).set({ onlineOrdersOff: d.off === true, onlineOrdersOffAt: FieldValue.serverTimestamp() }, { merge: true });
      await audit("onlineToggle", { bizId: biz.id, off: d.off === true });
      return { ok: true, off: d.off === true };
    }
    // 🧑‍💼 এজেন্টকে স্টক দেওয়া (এজেন্ট আগে টাকা দিয়েছেন) — বা সংশোধন (মাইনাস, কারণসহ)
    if (d.action === "agentStock") {
      const agentUid = s(d.agentUid, 128);
      const a = await db.collection("agents").doc(agentUid).get();
      if (!a.exists) throw new HttpsError("not-found", "এজেন্ট পাওয়া যায়নি");
      const credit = num(d.credit || 0, -1000000, 1000000, "ক্রেডিট");
      const subs = {}; MONTHS.forEach((m) => { subs[mk(m)] = Math.round(num((d.subs || {})[mk(m)] || 0, -10000, 10000, `${m} মাস`)); });
      const money = num(d.money || 0, 0, 100000000, "পাওয়া টাকা");
      const note = s(d.note, 200);
      const anyNeg = credit < 0 || MONTHS.some((m) => subs[mk(m)] < 0);
      if (!credit && MONTHS.every((m) => !subs[mk(m)])) throw new HttpsError("invalid-argument", "কিছু দিন — ক্রেডিট বা সাবস্ক্রিপশন");
      if (anyNeg && note.length < 3) throw new HttpsError("invalid-argument", "কমানোর কারণ লিখুন");
      const cc = d.country === "SA" ? "SA" : "BD";
      const ref = db.collection("agentStock").doc(agentUid);
      const res = await db.runTransaction(async (t) => {
        const st = await t.get(ref);
        const cur = st.exists ? st.data() : {};
        const nextCredit = r2(r2(cur.credit) + credit);
        if (nextCredit < 0) throw new HttpsError("failed-precondition", "এজেন্টের ক্রেডিট মাইনাস হয়ে যাবে");
        const nextSubs = {};
        MONTHS.forEach((m) => { nextSubs[mk(m)] = Math.round(Number(((cur.subs || {})[mk(m)]) || 0) + subs[mk(m)]); if (nextSubs[mk(m)] < 0) throw new HttpsError("failed-precondition", `${m} মাসের স্টক মাইনাস হয়ে যাবে`); });
        const now = FieldValue.serverTimestamp();
        t.set(ref, { agentUid, name: a.data().name || "", country: cur.country || cc, credit: nextCredit, subs: nextSubs, updatedAt: now,
          totals: { money: FieldValue.increment(money), creditIn: FieldValue.increment(credit) } }, { merge: true });
        t.set(ref.collection("ledger").doc(), { kind: "stock", credit, subs, money, note, byUid: me.uid, byName: me.name, creditAfter: nextCredit, subsAfter: nextSubs, at: now });
        const inc = { day: dayKey(), updatedAt: now, [cc]: {} };
        if (money) { inc[cc].income = FieldValue.increment(money); inc[cc].agentPays = FieldValue.increment(1); }
        if (credit) inc[cc].stockCredit = FieldValue.increment(credit);
        MONTHS.forEach((m) => { if (subs[mk(m)]) inc[cc]["stockSub" + m] = FieldValue.increment(subs[mk(m)]); });
        t.set(db.collection("billingDaily").doc(dayKey()), inc, { merge: true });
        return { credit: nextCredit, subs: nextSubs };
      });
      await audit("agentStock", { agentUid, credit, subs, money, note });
      return Object.assign({ ok: true }, res);
    }
    throw new HttpsError("invalid-argument", "অজানা কাজ");
  });

  /* =================== 🧑‍💼 এজেন্ট =================== */
  async function agentGiveTx(agent, biz, d, mode) {
    // mode: "give" (সরাসরি দোকানে) | "key" (কি বানানো)
    const cfg = await getConfig();
    const kind = d.kind === "sub" ? "sub" : "credit";
    const months = kind === "sub" ? Number(d.months) : 0;
    if (kind === "sub" && !MONTHS.includes(months)) throw new HttpsError("invalid-argument", "মাস ১/৩/৬/১২");
    const amount = kind === "credit" ? num(d.amount, 1, 100000, "ক্রেডিট") : 0;
    const sref = db.collection("agentStock").doc(agent.uid);
    const code = mode === "key" ? newKey() : null;
    const out = await db.runTransaction(async (t) => {
      const st = await t.get(sref);
      const cur = st.exists ? st.data() : {};
      let ctx = null;
      if (mode === "give") ctx = await readBiz(t, biz.id);
      if (kind === "credit" && r2(cur.credit) < amount) throw new HttpsError("failed-precondition", `আপনার ক্রেডিট স্টক যথেষ্ট নেই (আছে ${r2(cur.credit)})`);
      if (kind === "sub" && Number(((cur.subs || {})[mk(months)]) || 0) < 1) throw new HttpsError("failed-precondition", `আপনার কাছে ${months} মাসের সাবস্ক্রিপশন স্টক নেই`);
      const now = FieldValue.serverTimestamp();
      const upd = { updatedAt: now };
      if (kind === "credit") upd.credit = r2(r2(cur.credit) - amount);
      else upd.subs = Object.assign({}, cur.subs || {}, { [mk(months)]: Number(cur.subs[mk(months)]) - 1 });
      t.set(sref, upd, { merge: true });
      const what = kind === "credit" ? { amount } : { months };
      let res = {};
      if (mode === "give") {
        res = writeBiz(t, ctx, Object.assign({ bizId: biz.id, bizType: biz.type, country: biz.country, name: biz.name, agentUid: agent.uid,
          kind: kind === "sub" ? "sub" : "agent", byUid: agent.uid, byName: agent.name, note: "এজেন্ট " + agent.name }, kind === "sub" ? { months, amount: 0 } : { amount }));
        t.set(sref.collection("ledger").doc(), Object.assign({ kind: "give", bizId: biz.id, bizName: biz.name, at: now }, what));
      } else {
        const keyRef = sref.collection("keys").doc();
        t.set(db.collection("licenseKeys").doc(sha(normKey(code))), Object.assign({ status: "new", agentUid: agent.uid, agentName: agent.name,
          country: cur.country || "BD", agentKeyId: keyRef.id, bizId: biz ? biz.id : null, createdAt: now }, what));
        t.set(keyRef, Object.assign({ code, status: "new", bizId: biz ? biz.id : null, bizName: biz ? biz.name : null, createdAt: now }, what));
        t.set(sref.collection("ledger").doc(), Object.assign({ kind: "key", keyId: keyRef.id, last4: code.slice(-4), at: now }, what));
        res = { keyId: keyRef.id };
      }
      return Object.assign(res, { stockCredit: upd.credit ?? r2(cur.credit), stockSubs: upd.subs || cur.subs || {} });
    });
    return Object.assign({ ok: true, code }, out);
  }

  const billingAgent = onCall(async (request) => {
    const agent = await needAgent(request);
    const d = request.data || {};
    if (d.action === "shops") {
      // নিজের অধীনের সব ব্যবসা + তাদের ক্রেডিট/মেয়াদ/গিফট
      const lists = await Promise.all([
        db.collection("shops").where("assignedAgentId", "==", agent.uid).limit(500).get(),
        db.collection("transportDrivers").where("assignedAgentId", "==", agent.uid).limit(500).get(),
        agent.marketId ? db.collection("restaurants").where("marketId", "==", agent.marketId).limit(300).get() : null,
        agent.marketId ? db.collection("tailors").where("marketId", "==", agent.marketId).limit(300).get() : null,
      ]);
      const items = [];
      const push = (col, type, doc) => {
        const x = doc.data() || {};
        if ((col === "restaurants" || col === "tailors") && x.assignedAgentId && x.assignedAgentId !== agent.uid) return;
        items.push({ id: doc.id, col, type: col === "shops" && x.shopType === "pharmacy" ? "pharmacy" : type,
          name: x.shopName || x.name || x.fullName || "", phone: x.phone || x.ownerPhone || "", onlineOrdersOff: x.onlineOrdersOff === true });
      };
      lists[0].docs.forEach((x) => push("shops", "shop", x));
      lists[1].docs.forEach((x) => push("transportDrivers", "driver", x));
      if (lists[2]) lists[2].docs.forEach((x) => push("restaurants", "restaurant", x));
      if (lists[3]) lists[3].docs.forEach((x) => push("tailors", "tailor", x));
      const bills = items.length ? await db.getAll(...items.map((i) => db.collection("billing").doc(i.id))) : [];
      const now = Date.now();
      items.forEach((i, n) => {
        const b = bills[n] && bills[n].exists ? bills[n].data() : {};
        i.credit = r2(b.credit); i.giftGiven = !!b.giftGiven; i.giftCredit = r2(b.giftCredit);
        i.subUntil = tsMs(b.sub && b.sub.until) || null;
        i.subDaysLeft = i.subUntil ? Math.ceil((i.subUntil - now) / 86400000) : null;
      });
      return { ok: true, items };
    }
    if (d.action === "give" || d.action === "makeKey") {
      let biz = null;
      if (d.bizId) {
        biz = await findBiz(s(d.bizId, 128));
        if (!biz) throw new HttpsError("not-found", "ব্যবসা পাওয়া যায়নি");
        if (!agentOwns(agent, biz)) throw new HttpsError("permission-denied", "এই ব্যবসা আপনার অধীনে নয়");
      } else if (d.action === "give") throw new HttpsError("invalid-argument", "কোন ব্যবসা?");
      return agentGiveTx(agent, biz, d, d.action === "give" ? "give" : "key");
    }
    if (d.action === "voidKey") {
      const keyId = s(d.keyId, 64);
      const sref = db.collection("agentStock").doc(agent.uid);
      const kref = sref.collection("keys").doc(keyId);
      return db.runTransaction(async (t) => {
        const k = await t.get(kref);
        if (!k.exists) throw new HttpsError("not-found", "কি পাওয়া যায়নি");
        const kd = k.data();
        const lref = db.collection("licenseKeys").doc(sha(normKey(kd.code)));
        const l = await t.get(lref);
        const st = await t.get(sref);
        if (!l.exists || l.data().status !== "new") throw new HttpsError("failed-precondition", "এই কি আগেই ব্যবহার বা বাতিল হয়েছে");
        const cur = st.data() || {};
        const now = FieldValue.serverTimestamp();
        t.update(lref, { status: "void", voidAt: now });
        t.update(kref, { status: "void", voidAt: now });
        if (kd.months) t.set(sref, { subs: Object.assign({}, cur.subs || {}, { [mk(kd.months)]: Number(((cur.subs || {})[mk(kd.months)]) || 0) + 1 }), updatedAt: now }, { merge: true });
        else t.set(sref, { credit: r2(r2(cur.credit) + r2(kd.amount)), updatedAt: now }, { merge: true });
        t.set(sref.collection("ledger").doc(), { kind: "void", keyId, last4: String(kd.code).slice(-4), amount: kd.amount || null, months: kd.months || null, at: now });
        return { ok: true };
      });
    }
    throw new HttpsError("invalid-argument", "অজানা কাজ");
  });

  /* =================== 🏪 দোকানদার/ব্যবসা =================== */
  const billingShop = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const cfg = await getConfig();
    const bizId = await myBizId(me.uid);
    const biz = await findBiz(bizId);
    if (!biz) throw new HttpsError("not-found", "আপনার ব্যবসা পাওয়া যায়নি");
    const on = feeOn(cfg, biz.type);
    const pr = cfg.prices[biz.country];

    if (d.action === "status") {
      let justGifted = false;
      // 🎁 অটো গিফট — সুইচ চালু, এই ব্যবসা আগে পায়নি, এই ফোন/কম্পিউটার আগে পায়নি, আজকের সীমা বাকি
      const dev = s(d.deviceId, 100);
      // শুধু-সাবস্ক্রিপশনের ব্যবসায় (চালক, দর্জি) ক্রেডিটের কাজ নেই — গিফট দেওয়া হয় না
      if (on && cfg.gift.on && !SUB_ONLY.includes(biz.type) && dev.length >= 8 && Number(cfg.gift.credit[biz.country]) > 0) {
        const devRef = db.collection("giftDevices").doc(sha(dev));
        const dayRef = db.collection("billingDaily").doc(dayKey());
        justGifted = await db.runTransaction(async (t) => {
          const ctx = await readBiz(t, bizId);
          const dv = await t.get(devRef);
          const dy = await t.get(dayRef);
          if (ctx.cur.giftGiven || dv.exists) return false;
          const given = Number(((dy.exists ? dy.data() : {})[biz.country] || {}).gifts || 0)
            + Number(((dy.exists ? dy.data() : {})[biz.country === "SA" ? "BD" : "SA"] || {}).gifts || 0);
          if (given >= cfg.gift.dailyMax) return false;
          writeBiz(t, ctx, { bizId, bizType: biz.type, country: biz.country, name: biz.name, agentUid: biz.agentUid, kind: "gift",
            amount: cfg.gift.credit[biz.country], note: "🎁 Honey Bee-র স্বাগত উপহার", byUid: me.uid });
          t.set(devRef, { bizId, at: FieldValue.serverTimestamp() });
          return true;
        });
      }
      const b = await db.collection("billing").doc(bizId).get();
      const x = b.exists ? b.data() : {};
      const agent = await agentContact(biz);
      return {
        ok: true, on, giftOn: on && cfg.gift.on && !SUB_ONLY.includes(biz.type), subOnly: SUB_ONLY.includes(biz.type), justGifted, bizId, type: biz.type, country: biz.country,
        credit: r2(x.credit), giftCredit: r2(x.giftCredit), giftGiven: !!x.giftGiven,
        subUntil: tsMs(x.sub && x.sub.until) || null, subActive: subActive(x),
        prices: { perSale: pr.perSale, orderFee: pr.orderFee, sub: pr.sub }, agent,
        onlineOrdersOff: biz.onlineOrdersOff,
      };
    }
    if (d.action === "redeem") {
      // 🔑 ভুল কি বারবার — ঘণ্টায় ৫ বার
      const tryRef = db.collection("billingKeyTries").doc(me.uid);
      const tr = await tryRef.get();
      const tx = tr.exists ? tr.data() : {};
      const fresh = Date.now() - tsMs(tx.since) > 3600000;
      if (!fresh && Number(tx.n || 0) >= 5) throw new HttpsError("resource-exhausted", "অনেকবার ভুল কি দেওয়া হয়েছে — ১ ঘণ্টা পরে আবার চেষ্টা করুন");
      const code = normKey(d.key);
      const bad = async () => {
        await tryRef.set({ n: fresh ? 1 : Number(tx.n || 0) + 1, since: fresh ? Timestamp.now() : (tx.since || Timestamp.now()) });
        throw new HttpsError("not-found", "কি সঠিক নয়, বা আগেই ব্যবহার হয়েছে");
      };
      if (code.length !== 12) return bad();
      const lref = db.collection("licenseKeys").doc(sha(code));
      const res = await db.runTransaction(async (t) => {
        const l = await t.get(lref);
        if (!l.exists || l.data().status !== "new") return { bad: true };
        const k = l.data();
        if (k.bizId && k.bizId !== bizId) return { other: true };
        if ((k.country || "BD") !== biz.country) return { country: true };
        const ctx = await readBiz(t, bizId);
        const kref = db.collection("agentStock").doc(k.agentUid).collection("keys").doc(k.agentKeyId);
        const r = writeBiz(t, ctx, Object.assign({ bizId, bizType: biz.type, country: biz.country, name: biz.name, agentUid: k.agentUid,
          kind: "key", byUid: me.uid, note: "লাইসেন্স কি …" + code.slice(-4) + " (এজেন্ট " + (k.agentName || "") + ")" },
          k.months ? { months: k.months, amount: 0 } : { amount: k.amount }));
        const now = FieldValue.serverTimestamp();
        t.update(lref, { status: "used", usedBy: bizId, usedByName: biz.name, usedAt: now });
        t.set(kref, { status: "used", usedBy: bizId, usedByName: biz.name, usedAt: now }, { merge: true });
        return Object.assign({ ok: true, amount: k.amount || 0, months: k.months || 0 }, r);
      });
      if (res.bad) return bad();
      if (res.other) throw new HttpsError("permission-denied", "এই কি অন্য একটা ব্যবসার জন্য বানানো");
      if (res.country) throw new HttpsError("failed-precondition", "এই কি অন্য দেশের জন্য");
      return res;
    }
    throw new HttpsError("invalid-argument", "অজানা কাজ");
  });

  /* =================== 🧾 দোকানে বিক্রিতে কাটা (আয়-৭) ===================
     POS-এর প্রতিটা বিক্রি ক্লাউডে shops/{shopId}/ledger/entries~id:… নথি হয়ে জমা হয়।
     নতুন নথি তৈরি হলে: মূল সুইচ + ধরনের সুইচ চালু, সাবস্ক্রিপশন নেই → প্রতি বিক্রিতে কাটা।
     • একই রসিদের (invoiceNo) কয়েকটা লাইন — একবারই কাটে
     • অনলাইন অর্ডারের বিক্রি — কাটে না (গ্রহণের সময়ই কাটা হয়েছে)
     • পুরনো বিক্রি (নতুন ফোনে প্রথম সিঙ্ক, ৩ দিনের বেশি পুরনো) — কাটে না
     • ক্রেডিট শেষ হলেও খাতা চলে — ক্রেডিট মাইনাসে যায়, দোকানদারকে মনে করানো হয় */
  async function chargeSale(shopId, raw) {
    const cfg = await getConfig();
    if (!cfg.enabled) return { skip: "off" };
    let e; try { e = JSON.parse(raw); } catch (x) { return { skip: "parse" }; }
    if (!e || typeof e !== "object" || e.onlineOrderId) return { skip: "online" };
    const at = Date.parse(e.date || "") || Date.now();
    if (Date.now() - at > 3 * 86400000) return { skip: "old" };
    const biz = await findBiz(shopId);
    if (!biz || !feeOn(cfg, biz.type)) return { skip: "type" };
    const b = await db.collection("billing").doc(shopId).get();
    const x = b.exists ? b.data() : {};
    if (subActive(x, at)) return { skip: "sub" };
    if (tsMs(x.chargeFrom) && at < tsMs(x.chargeFrom) - 86400000) return { skip: "before" };
    const fee = r2(cfg.prices[biz.country].perSale);
    if (!(fee > 0)) return { skip: "free" };
    return billingApply({ bizId: shopId, bizType: biz.type, country: biz.country, name: biz.name, agentUid: biz.agentUid,
      kind: "sale", amount: -fee, allowNegative: true, dedupeKey: "sale:" + (e.invoiceNo || e.id || raw.slice(0, 60)),
      note: (e.invoiceNo ? "#" + String(e.invoiceNo).replace("INV-", "") + " " : "") + s(e.item || e.name || "বিক্রি", 40) });
  }
  const billingOnSale = onDocumentCreated("shops/{shopId}/ledger/{docId}", async (event) => {
    const id = event.params.docId || "";
    if (id.indexOf("entries~") !== 0) return;
    const x = event.data && event.data.data();
    if (!x || x.d || x.t !== "row" || typeof x.v !== "string") return;
    try { await chargeSale(event.params.shopId, x.v); }
    catch (e) { console.warn(JSON.stringify({ event: "BILLING_SALE_FAILED", shopId: event.params.shopId, error: String(e && e.message || e) })); }
  });
  // 🍽️ রেস্টুরেন্টের দোকানে-বসা বিল (restaurants/{uid}/bills) — প্রতি বিলে একবার
  // নথি নতুন হলে, বা একই নম্বরে নতুন বিল বসলে (অর্ডার-নম্বর ঘুরে এলে createdAt বদলায়) — তখনই কাটা।
  // শুধু অবস্থা বদলালে (রান্না/পরিশোধ) কিছু করে না।
  const billingOnRestaurantBill = onDocumentWritten("restaurants/{rid}/bills/{billId}", async (event) => {
    const before = event.data && event.data.before && event.data.before.exists ? (event.data.before.data() || {}) : null;
    const afterSnap = event.data && event.data.after;
    if(!afterSnap || !afterSnap.exists) return;
    const ax = afterSnap.data() || {};
    if(before && String(before.createdAt || before.date || "") === String(ax.createdAt || ax.date || "")) return;
    try {
      const cfg = await getConfig();
      if (!feeOn(cfg, "restaurant")) return;
      const x = ax;
      const o = x.o || x;
      const at = Date.parse(o.date || o.createdAt || "") || Date.now();
      if (Date.now() - at > 3 * 86400000) return;
      if (o.onlineOrderId || o.source === "bazar") return;
      const rid = event.params.rid;
      const biz = await findBiz(rid);
      if (!biz) return;
      const b = await db.collection("billing").doc(rid).get();
      const bx = b.exists ? b.data() : {};
      if (subActive(bx, at)) return;
      if (tsMs(bx.chargeFrom) && at < tsMs(bx.chargeFrom) - 86400000) return;
      const fee = r2(cfg.prices[biz.country].perSale);
      if (!(fee > 0)) return;
      await billingApply({ bizId: rid, bizType: "restaurant", country: biz.country, name: biz.name, agentUid: biz.agentUid,
        kind: "sale", amount: -fee, allowNegative: true, dedupeKey: "rbill:" + event.params.billId + ":" + (o.createdAt || o.date || ""), note: "বিল " + event.params.billId.replace(/^o_/, "#") });
    } catch (e) { console.warn(JSON.stringify({ event: "BILLING_RBILL_FAILED", error: String(e && e.message || e) })); }
  });

  /* =================== 🛒 অনলাইন অর্ডার-ফি (আয়-৮) ===================
     ১) অর্ডার দোকানে যাওয়ার মুহূর্তে (holding → pending, releaseHeldOrders) — ফি চালু থাকলে
        গ্রাহকের নাম/ফোন/ঠিকানা/ম্যাপ orderRequests/{id}/secret/contact-এ সরে যায়,
        মূল নথিতে থাকে শুধু পণ্য আর "প্রায় X কিমি দূরে"। নোটের ফোন নম্বর ঢাকা।
     ২) দোকান "গ্রহণ" চাপলে orderAccept — একই রসিদে একবার ফি কাটে, তথ্য ফিরে আসে।
        ক্রেডিট না থাকলে গ্রহণ হয় না — এজেন্টের নম্বরসহ জানানো হয়।
     ৩) দোকান পরে বাতিল করলে ফেরত নেই; গ্রাহক গ্রহণের আগে বাতিল করলে কিছুই কাটে না। */
  const CONTACT_FIELDS = ["customerName", "deliveryAddress", "deliveryPhone", "deliveryLat", "deliveryLng", "packLabel", "selfReceive"];
  const maskPhones = (t) => typeof t === "string" ? t.replace(/(\+?৮৮|\+?88)?[০0][১1][৩-৯3-9](?:[ \-]?[০-৯0-9]){8}/g, "০১•••••••••") : t;
  const bizCache = new Map();
  async function bizForOrder(shopId) {
    const hit = bizCache.get(shopId);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.v;
    const v = await findBiz(shopId);
    bizCache.set(shopId, { at: Date.now(), v });
    if (bizCache.size > 300) bizCache.delete(bizCache.keys().next().value);
    return v;
  }
  // releaseHeldOrders-এর ব্যাচে ডাকা হয়: holding → pending করার সময়
  async function maskOnRelease(docSnap, batch, perDocDelivery) {
    const o = docSnap.data() || {};
    if (o.contactHidden || o.feePaid) return null;
    const cfg = await getConfig();
    if (!cfg.enabled) return null;
    const biz = await bizForOrder(o.shopId);
    if (!biz || !feeOn(cfg, biz.type)) return null;
    const secret = {};
    CONTACT_FIELDS.forEach((k) => { if (o[k] !== undefined) secret[k] = o[k]; });
    secret.customerUid = o.customerUid || null; secret.shopId = o.shopId; secret.note = o.note || null;
    secret.at = FieldValue.serverTimestamp();
    batch.set(docSnap.ref.collection("secret").doc("contact"), secret);
    const km = perDocDelivery && perDocDelivery.distanceMeters ? Math.round(perDocDelivery.distanceMeters / 100) / 10 : null;
    const upd = { contactHidden: true, feeAmount: r2(cfg.prices[biz.country].orderFee), approxKm: km,
      customerName: "👤 গ্রাহক (গ্রহণের পর দেখা যাবে)", deliveryAddress: o.deliveryMode === "pickup" ? o.deliveryAddress : "📍 গ্রহণের পর দেখা যাবে",
      deliveryPhone: "", deliveryLat: null, deliveryLng: null, packLabel: null, selfReceive: null };
    if (o.note) upd.note = maskPhones(o.note);
    return upd;
  }
  // পুরনো অ্যাপ থেকে সরাসরি "pending" হয়ে আসা অর্ডার (holding ছাড়া) — তৈরি হওয়ামাত্র ঢাকা
  const billingOnOrderCreated = onDocumentCreated("orderRequests/{orderId}", async (event) => {
    try {
      const snap = event.data; if (!snap) return;
      const o = snap.data() || {};
      if (o.status !== "pending" || o.contactHidden) return;
      const batch = db.batch();
      const upd = await maskOnRelease(snap, batch, null);
      if (!upd) return;
      batch.set(snap.ref, upd, { merge: true });
      await batch.commit();
    } catch (e) { console.warn(JSON.stringify({ event: "BILLING_MASK_FAILED", error: String(e && e.message || e) })); }
  });

  const orderAccept = onCall(async (request) => {
    const me = needUser(request);
    const orderId = s((request.data || {}).orderId, 128);
    const first = await db.collection("orderRequests").doc(orderId).get();
    if (!first.exists) throw new HttpsError("not-found", "অর্ডার পাওয়া যায়নি");
    const o = first.data();
    const bizId = await myBizId(me.uid);
    if (o.shopId !== bizId) throw new HttpsError("permission-denied", "এটা আপনার দোকানের অর্ডার নয়");
    // একই রসিদের (orderCode + গ্রাহক) এই দোকানের সব পণ্য একসাথে
    let docs = [first];
    if (o.orderCode) {
      const q = await db.collection("orderRequests").where("orderCode", "==", o.orderCode).where("shopId", "==", o.shopId).limit(50).get();
      docs = q.docs.filter((x) => (x.data().customerUid || "") === (o.customerUid || ""));
      if (!docs.length) docs = [first];
    }
    const hidden = docs.filter((x) => x.data().contactHidden && !x.data().feePaid);
    if (!hidden.length) return { ok: true, already: true };
    const biz = await findBiz(bizId);
    const fee = r2(hidden[0].data().feeAmount);
    const secrets = await Promise.all(hidden.map((x) => x.ref.collection("secret").doc("contact").get()));
    const res = await db.runTransaction(async (t) => {
      const ctx = await readBiz(t, bizId, "order:" + (o.orderCode || orderId) + ":" + bizId);
      const fresh = await Promise.all(hidden.map((x) => t.get(x.ref)));
      if (fresh.every((f) => f.data().feePaid)) return { ok: true, already: true };
      if (!ctx.dup && fee > 0) {
        const next = r2(r2(ctx.cur.credit) + -fee);
        if (next < 0) return { ok: false, reason: "low_credit", credit: r2(ctx.cur.credit), fee };
        writeBiz(t, ctx, { bizId, bizType: biz.type, country: biz.country, name: biz.name, agentUid: biz.agentUid,
          kind: "order", amount: -fee, note: "অনলাইন অর্ডার " + (o.orderCode || orderId.slice(-6)), ref: orderId, byUid: me.uid });
      }
      fresh.forEach((f, i) => {
        const sec = secrets[i].exists ? secrets[i].data() : {};
        const back = { feePaid: true, feePaidAt: FieldValue.serverTimestamp(), contactHidden: false };
        CONTACT_FIELDS.forEach((k) => { if (sec[k] !== undefined) back[k] = sec[k]; });
        if (sec.note) back.note = sec.note;
        t.set(f.ref, back, { merge: true });
      });
      return { ok: true, fee, credit: ctx.dup ? r2(ctx.cur.credit) : r2(r2(ctx.cur.credit) - fee) };
    });
    if (!res.ok && res.reason === "low_credit") res.agent = await agentContact(biz);
    return res;
  });

  /* 🚑 ট্রান্সপোর্ট — শুধু সাবস্ক্রিপশন: মূল সুইচ + "ট্রান্সপোর্ট" টিক চালু থাকলে যাঁদের
     সাবস্ক্রিপশন নেই তাঁরা যাত্রীর ডাক পান না। বন্ধ থাকলে null (কাউকে বাদ দেয় না)। */
  async function driversWithSub(ids) {
    const cfg = await getConfig();
    if (!feeOn(cfg, "driver") || !ids.length) return null;
    const snaps = await db.getAll(...ids.map((id) => db.collection("billing").doc(id)));
    const ok = new Set();
    snaps.forEach((d, i) => { if (d.exists && subActive(d.data())) ok.add(ids[i]); });
    return ok;
  }

  return {
    exports: { billingAdmin, billingAgent, billingShop, billingOnSale, billingOnRestBill: billingOnRestaurantBill, billingOnOrderCreated, orderAccept },
    maskOnRelease, driversWithSub,
    _test: { billingApply, getConfig, cleanConfig, defaults, chargeSale, newKey, normKey, sha, maskPhones },
  };
};
