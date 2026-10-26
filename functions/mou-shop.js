/* =====================================================================
   🐝 মৌ — দোকান/দর্জি/রেস্টুরেন্টের হয়ে Messenger-এ উত্তর (ধাপ ৫, অক্টোবর ২০২৬)

   কখন উত্তর দেয় (সবগুলো শর্ত মিললে তবেই):
   · গ্রাহক Honey Messenger-এ এমন কাউকে লিখলেন যিনি দোকান, দর্জি বা রেস্টুরেন্টের মালিক
   · মালিক এখন অনলাইনে নেই (Messenger শেষ ৩ মিনিটে খোলা হয়নি)
   · মালিক নিজের সেটিংসে "অনলাইনে না থাকলে মৌ উত্তর দেবে" বন্ধ করেননি (শুরুতে চালু)
   · চ্যাটটা প্রাইভেসি মোডে না (গোপন কথায় মৌ ঢোকে না)
   · একই চ্যাটে শেষ উত্তরের পর অন্তত ৪৫ সেকেন্ড গেছে, আর আজ এই চ্যাটে ১৫টার কম
     উত্তর হয়েছে; একটা ব্যবসার জন্য দিনে সর্বোচ্চ ২০০টা (Gemini-এর খরচ নিয়ন্ত্রণে)

   কী বলে: শুধু সেই ব্যবসার আসল তথ্য থেকে — খোলা/বন্ধ, এলাকা, পণ্য/খাবার/ডিজাইন
   আর তার দাম। জানা না থাকলে বলে "মালিক অনলাইনে এলে জানাবেন"। কখনো দাম বানায় না,
   অর্ডার নিশ্চিত করে না। প্রতিটা উত্তরে byMou:true থাকে — অ্যাপ সেটাকে
   "🐝 মৌ উত্তর দিয়েছে" লিখে দেখায়।
   ===================================================================== */

module.exports = function makeMouShop({ db, FieldValue, Timestamp, onDocumentCreated, geminiApiKey }) {
  const OFFLINE_MS = 3 * 60 * 1000;
  const GAP_MS = 45 * 1000;
  const PER_CHAT_DAY = 15;
  const PER_BIZ_DAY = 200;
  const bdDay = () => new Date(Date.now() + 6 * 3600000).toISOString().slice(0, 10);
  const BN = "০১২৩৪৫৬৭৮৯";
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/[০-৯]/g, (c) => BN.indexOf(c)).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

  /* ---------- এই মানুষটা কোন ব্যবসার মালিক? ---------- */
  async function findBusiness(uid) {
    const [t, r, s1, s2] = await Promise.all([
      db.collection("tailors").doc(uid).get().catch(() => null),
      db.collection("restaurants").doc(uid).get().catch(() => null),
      db.collection("shops").doc(uid).get().catch(() => null),
      db.collection("shops").where("ownerUid", "==", uid).limit(3).get().catch(() => null),
    ]);
    const shops = [];
    if (s1 && s1.exists && s1.data().status !== "blocked") shops.push({ id: s1.id, ...s1.data() });
    if (s2) s2.docs.forEach((d) => { if (!shops.find((x) => x.id === d.id) && d.data().status !== "blocked") shops.push({ id: d.id, ...d.data() }); });
    if (shops.length) return { kind: "shop", id: shops[0].id, data: shops[0] };
    if (t && t.exists) return { kind: "tailor", id: t.id, data: t.data() };
    if (r && r.exists) return { kind: "restaurant", id: r.id, data: r.data() };
    return null;
  }

  /* ---------- ব্যবসার আসল তথ্য, ছোট করে (Gemini-কে দেওয়ার জন্য) ---------- */
  function pickRelevant(items, text, nameOf, max) {
    const words = norm(text).split(" ").filter((w) => w.length >= 2);
    const scored = items.map((it) => {
      const n = norm(nameOf(it));
      return { it, s: words.reduce((a, w) => a + (n.includes(w) ? 1 : 0), 0) };
    });
    const hit = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.it);
    const rest = scored.filter((x) => x.s === 0).map((x) => x.it);
    return hit.concat(rest).slice(0, max);
  }
  async function businessFacts(biz, text) {
    const d = biz.data || {};
    const cur = d.countryCode === "SA" ? "SAR " : "৳";
    const lines = [];
    if (biz.kind === "shop") {
      lines.push(`ধরন: দোকান · নাম: ${d.shopName || d.name || "দোকান"}`);
      lines.push(`এখন: ${d.isShopOpen === false ? "বন্ধ (অনলাইন অর্ডার নেওয়া হচ্ছে না)" : "খোলা"}`);
      if (d.upazila || d.district || d.address) lines.push(`ঠিকানা/এলাকা: ${[d.address, d.upazila, d.district].filter(Boolean).join(", ")}`);
      const qs = await db.collection("shops").doc(biz.id).collection("publicStock").limit(400).get().catch(() => null);
      const items = qs ? qs.docs.map((x) => x.data()).filter((p) => p && p.name && !p.private) : [];
      const list = pickRelevant(items, text, (p) => p.name, 35);
      lines.push(`পণ্য (Bazar-এ প্রকাশিত ${items.length}টার মধ্যে প্রাসঙ্গিকগুলো):`);
      list.forEach((p) => {
        const price = p.offerLive && Number(p.offerPrice) > 0 ? Number(p.offerPrice) : Number(p.price) || 0;
        const stock = typeof p.stockQty === "number" ? (p.stockQty <= 0 ? " · স্টক শেষ" : ` · স্টক ${p.stockQty}`) : "";
        lines.push(`- ${p.name}: ${cur}${price}${p.unit && p.unit !== "pcs" ? "/" + p.unit : ""}${stock}`);
      });
    } else if (biz.kind === "tailor") {
      lines.push(`ধরন: দর্জি (সেলাই ঘর) · নাম: ${d.name || "সেলাই ঘর"}`);
      lines.push(`এখন: ${d.isOpen === false ? "বন্ধ" : "খোলা"}`);
      if (d.address || d.area || d.upazila) lines.push(`ঠিকানা/এলাকা: ${[d.address, d.area, d.upazila, d.district].filter(Boolean).join(", ")}`);
      const qs = await db.collection("tailorDesigns").where("tailorId", "==", biz.id).limit(80).get().catch(() => null);
      const items = qs ? qs.docs.map((x) => x.data()).filter((x) => x.published && x.status === "active") : [];
      lines.push("ডিজাইন ও মজুরি:");
      pickRelevant(items, text, (x) => (x.title || "") + " " + (x.category || ""), 30)
        .forEach((x) => lines.push(`- ${x.title}: মজুরি ৳${x.price}${x.days ? ` · ${x.days} দিনে` : ""}`));
      lines.push("অর্ডার: Bazar-এর সেলাই ঘরে ডিজাইনে চাপ দিয়ে মাপ দিয়ে অর্ডার; কাপড় রাইডার নিতে পারে বা নিজে দিয়ে আসা যায়।");
    } else {
      lines.push(`ধরন: রেস্টুরেন্ট · নাম: ${d.name || "রেস্টুরেন্ট"}`);
      lines.push(`এখন: ${d.isOpen === false ? "বন্ধ" : "খোলা"}`);
      if (d.address || d.upazila) lines.push(`ঠিকানা/এলাকা: ${[d.address, d.upazila, d.district].filter(Boolean).join(", ")}`);
      const qs = await db.collection("restaurants").doc(biz.id).collection("foods").limit(200).get().catch(() => null);
      const items = qs ? qs.docs.map((x) => x.data()).filter((f) => f && f.name && f.published !== false) : [];
      lines.push("মেনু:");
      pickRelevant(items, text, (f) => (f.name || "") + " " + (f.cat || ""), 35)
        .forEach((f) => lines.push(`- ${f.name}: ${d.cur || cur}${f.price}${f.available === false ? " · এখন নেই" : ""}`));
    }
    return lines.join("\n").slice(0, 6000);
  }

  async function geminiAnswer(apiKey, facts, history, text) {
    const sys = `তুমি "মৌ" — Honey Bee Bazar-এর সহকারী। এখন একজন ব্যবসার মালিক অনলাইনে নেই, তাই তাঁর হয়ে গ্রাহকের প্রশ্নের উত্তর দিচ্ছ।
নিয়ম:
- শুধু নিচের "ব্যবসার তথ্য" থেকে উত্তর দেবে। তথ্যে নেই এমন দাম, স্টক, সময়, ছাড়, ডেলিভারি সময় কখনো বানাবে না।
- জানা না থাকলে বলবে: "এটা আমি নিশ্চিত জানি না — মালিক অনলাইনে এলে আপনাকে জানাবেন।"
- কোনো অর্ডার, দাম কমানো বা কথা দেওয়া নিশ্চিত করবে না। কিনতে চাইলে বলবে Bazar অ্যাপ থেকে অর্ডার দিতে।
- ভদ্র, ছোট (১-৩ বাক্য), গ্রাহক যে ভাষায় লিখেছেন সেই ভাষায় (সাধারণত বাংলা)।
- শুধু JSON: {"reply":"..."}

===== ব্যবসার তথ্য =====
${facts}
===== তথ্য শেষ =====`;
    const contents = history.map((h) => ({ role: h.mine ? "model" : "user", parts: [{ text: h.text }] }));
    contents.push({ role: "user", parts: [{ text }] });
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, generationConfig: { temperature: 0.3, responseMimeType: "application/json" } }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    const raw = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(raw || "{}");
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    if (!reply) throw new Error("empty reply");
    return reply.slice(0, 700);
  }

  let __ai = null, __aiAt = 0;
  async function aiOn() {
    if (__ai !== null && Date.now() - __aiAt < 5 * 60 * 1000) return __ai;
    try { const d = await db.collection("appConfig").doc("mou").get(); __ai = !!(d.exists && d.data().aiEnabled === true); }
    catch (e) { __ai = false; }
    __aiAt = Date.now();
    return __ai;
  }

  const mouShopAutoReply = onDocumentCreated(
    { document: "messengerChats/{chatId}/messages/{messageId}", secrets: [geminiApiKey] },
    async (event) => {
      const chatId = event.params.chatId;
      const m = event.data && event.data.data();
      if (!m || m.byMou || !m.senderUid || typeof m.text !== "string" || !m.text.trim()) return;
      // 💸 AI বন্ধ (ডিফল্ট) — কিছুই পড়া হয় না, Gemini ডাকা হয় না, খরচ শূন্য।
      // সুপার এডমিন appConfig/mou-তে aiEnabled: true বসালে তবেই চালু।
      if (!(await aiOn())) return;

      const chatRef = db.collection("messengerChats").doc(chatId);
      const chat = await chatRef.get();
      if (!chat.exists) return;
      const c = chat.data();
      if (c.mode === "privacy") return;
      const owner = (c.participants || []).find((u) => u !== m.senderUid);
      if (!owner) return;

      // মালিক অনলাইনে আছেন? বা মৌ বন্ধ করে রেখেছেন?
      const ou = await db.collection("messengerUsers").doc(owner).get();
      const od = ou.exists ? ou.data() : {};
      if (od.mouAutoReply === false) return;
      const seen = od.lastSeen && od.lastSeen.toMillis ? od.lastSeen.toMillis() : 0;
      if (Date.now() - seen < OFFLINE_MS) return;

      const biz = await findBusiness(owner);
      if (!biz) return; // সাধারণ মানুষ — দোকান/দর্জি/রেস্টুরেন্ট না

      // সীমা — একই চ্যাটে খুব ঘন ঘন না, দিনে নির্দিষ্ট কয়েকটা
      const day = bdDay();
      const usageRef = db.collection("mouUsage").doc("biz_" + owner);
      const ok = await db.runTransaction(async (tx) => {
        const [cs, us] = await Promise.all([tx.get(chatRef), tx.get(usageRef)]);
        const cd = cs.data() || {};
        const last = cd.mouLastAt && cd.mouLastAt.toMillis ? cd.mouLastAt.toMillis() : 0;
        const chatN = cd.mouDay === day ? Number(cd.mouN) || 0 : 0;
        const ud = us.exists ? us.data() : {};
        const bizN = ud.day === day ? Number(ud.n) || 0 : 0;
        if (Date.now() - last < GAP_MS || chatN >= PER_CHAT_DAY || bizN >= PER_BIZ_DAY) return false;
        tx.set(chatRef, { mouLastAt: Timestamp.now(), mouDay: day, mouN: chatN + 1 }, { merge: true });
        tx.set(usageRef, { day, n: bizN + 1, updatedAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (!ok) return;

      const apiKey = geminiApiKey.value();
      if (!apiKey) return;
      try {
        const hs = await chatRef.collection("messages").orderBy("timestamp", "desc").limit(8).get();
        const history = hs.docs.reverse().filter((d) => d.id !== event.params.messageId)
          .map((d) => d.data()).filter((x) => x && typeof x.text === "string" && x.text.trim())
          .map((x) => ({ mine: x.senderUid === owner, text: x.text.slice(0, 400) }));
        const facts = await businessFacts(biz, m.text);
        const reply = await geminiAnswer(apiKey, facts, history, m.text.trim().slice(0, 500));
        await chatRef.collection("messages").add({
          senderUid: owner, text: reply, byMou: true, timestamp: FieldValue.serverTimestamp(),
        });
        await chatRef.set({ lastMessage: "🐝 " + reply.slice(0, 80), lastMessageAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log(JSON.stringify({ event: "MOU_SHOP_REPLIED", chatId, kind: biz.kind }));
      } catch (e) {
        console.warn(JSON.stringify({ event: "MOU_SHOP_FAILED", chatId, error: String(e && e.message || e) }));
      }
    }
  );

  return { mouShopAutoReply, _test: { findBusiness, businessFacts, norm } };
};
