/* =====================================================================
   🐝 মৌ-এর "চোখ" — বাজারের আসল তথ্য খোঁজা (ধাপ ৫, অক্টোবর ২০২৬)

   মৌ (Gemini) নিজে কখনো দাম/স্টক বলে না। সে শুধু বোঝে গ্রাহক কী চাইছেন
   (যেমন {type:"find_product", words:["আলু"], sort:"cheap"})। তারপর এই ফাইলের
   কোড Firestore থেকে আসল দোকান, আসল দাম, আসল ডিজাইন খুঁজে কার্ড বানায়।
   তাই উত্তরের প্রতিটা দাম ডেটাবেস থেকে আসে, AI-এর কল্পনা থেকে না।

   খরচ বাঁচাতে: একই এলাকার দোকান/পণ্যের তালিকা ১৫ মিনিট মেমোরিতে রাখা হয়
   (ফাংশনের একই ইনস্ট্যান্সে পরপর প্রশ্ন এলে আবার পড়তে হয় না)।
   ===================================================================== */

module.exports = function makeMouTools({ db }) {
  const TTL = 15 * 60 * 1000; // 💸 ১৫ মিনিট — Firestore-এর ফ্রি সীমার ভেতরে থাকতে
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.val;
    const val = await fn();
    cache.set(key, { at: Date.now(), val });
    if (cache.size > 60) cache.delete(cache.keys().next().value);
    return val;
  }

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[‌‍]/g, "")
      .replace(/[.,!?;:()\[\]{}"'`৷।\-_/\\|+*#@&%$^~<>=]/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function cleanWords(words, query) {
    const out = [];
    [].concat(Array.isArray(words) ? words : [], query ? [query] : []).forEach((w) => {
      const n = norm(w).slice(0, 40);
      if (n.length >= 2 && !out.includes(n)) out.push(n);
    });
    return out.slice(0, 6);
  }
  function scoreName(name, words) {
    const n = norm(name);
    if (!words.length) return 1;
    let best = 0;
    words.forEach((w) => {
      if (!n.includes(w)) return;
      let s = 2;
      if (n === w) s = 6;
      else if (n.startsWith(w + " ") || n.startsWith(w)) s = 4;
      else if ((" " + n + " ").includes(" " + w + " ")) s = 3;
      best = Math.max(best, s);
    });
    return best;
  }
  function cleanArea(a) {
    const s = (v) => (typeof v === "string" ? v.trim().slice(0, 60) : "");
    return { d: s(a && a.d), u: s(a && a.u) };
  }
  const tsMs = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : (typeof t === "number" ? t : 0));

  /* ---------- 🏪 এলাকার দোকান আর তাদের বাজারে-প্রকাশিত পণ্য ---------- */
  async function areaShops(area) {
    return cached("shops|" + area.d + "|" + area.u, async () => {
      let q;
      if (area.u) q = db.collection("shops").where("upazila", "==", area.u).limit(150);
      else if (area.d) q = db.collection("shops").where("district", "==", area.d).limit(150);
      else q = db.collection("shops").where("status", "==", "active").limit(80);
      const qs = await q.get();
      return qs.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((s) => s.status === "active" && (!area.d || !s.district || s.district === area.d))
        .slice(0, 40)
        .map((s) => ({ id: s.id, name: s.shopName || s.name || "দোকান", upazila: s.upazila || "", district: s.district || "", cc: s.countryCode || "BD" }));
    });
  }
  async function areaProducts(area) {
    return cached("prod|" + area.d + "|" + area.u, async () => {
      const shops = await areaShops(area);
      const lists = await Promise.all(shops.map(async (s) => {
        try {
          const qs = await db.collection("shops").doc(s.id).collection("publicStock").limit(200).get();
          return qs.docs.map((d) => {
            const p = d.data() || {};
            if (p.private) return null;
            const offer = p.offerLive && Number(p.offerPrice) > 0 ? Number(p.offerPrice) : null;
            return {
              kind: "product", shopId: s.id, productId: d.id, shopName: s.name, upazila: s.upazila, cur: s.cc === "SA" ? "SAR " : "৳",
              name: String(p.name || "").slice(0, 80), price: offer != null ? offer : (Number(p.price) || 0),
              oldPrice: offer != null ? (Number(p.price) || null) : null, unit: p.unit || "",
              img: p.imageUrl || null, inStock: !(typeof p.stockQty === "number" && p.stockQty <= 0),
            };
          }).filter((x) => x && x.name && x.price > 0);
        } catch (e) { return []; }
      }));
      return [].concat(...lists);
    });
  }
  async function findProducts(action, area) {
    const words = cleanWords(action.words, action.query);
    if (!words.length) return [];
    const all = await areaProducts(area);
    const hits = all.map((p) => ({ p, s: scoreName(p.name, words) })).filter((x) => x.s > 0);
    hits.sort((a, b) => {
      if (a.p.inStock !== b.p.inStock) return a.p.inStock ? -1 : 1;
      if (action.sort === "cheap") return a.p.price - b.p.price || b.s - a.s;
      return b.s - a.s || a.p.price - b.p.price;
    });
    const max = Number(action.maxPrice) > 0 ? Number(action.maxPrice) : null;
    return hits.map((x) => x.p).filter((p) => !max || p.price <= max).slice(0, 6);
  }

  /* ---------- 🧵 দর্জির ডিজাইন ---------- */
  const CATS = ["kameez", "pajama", "set", "blouse", "kids", "other"];
  async function findDesigns(action, area) {
    const all = await cached("designs", async () => {
      const qs = await db.collection("tailorDesigns").where("published", "==", true).limit(300).get();
      return qs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.status === "active" && d.img);
    });
    // 💰 দর্জির সাবস্ক্রিপশন চালু থাকলে — শুধু সাবস্ক্রিপশন থাকা দর্জির ডিজাইন
    const subOk = await cached("tlrSub", async () => {
      const c = await db.collection("billingConfig").doc("main").get().catch(() => null);
      const x = c && c.exists ? c.data() : {};
      if (!(x.enabled && x.types && x.types.tailor)) return null;
      const qs = await db.collection("tailors").where("hbSubUntil", ">", new Date()).limit(500).get();
      return qs.docs.map((d) => d.id);
    });
    const words = cleanWords(action.words, action.query).filter((w) => !/^(দর্জি|দর্জির|সেলাই|টেইলার|tailor|ডিজাইন|জামা সেলাই)$/.test(w));
    const max = Number(action.maxPrice) > 0 ? Number(action.maxPrice) : null;
    const cat = CATS.includes(action.category) ? action.category : null;
    const pool = subOk ? all.filter((d) => subOk.includes(d.tailorId)) : all;
    let list = pool.filter((d) => (!area.d || d.district === area.d) && (!area.u || d.upazila === area.u));
    if (!list.length && area.u) list = pool.filter((d) => !area.d || d.district === area.d); // থানায় না থাকলে জেলায়
    list = list.filter((d) => (!max || Number(d.price) <= max) && (!cat || d.category === cat));
    if (words.length) {
      const w = list.filter((d) => scoreName((d.title || "") + " " + (d.note || ""), words) > 0);
      if (w.length) list = w;
    }
    list.sort((a, b) => (action.sort === "cheap" || max ? Number(a.price) - Number(b.price) : tsMs(b.createdAt) - tsMs(a.createdAt)));
    return list.slice(0, 6).map((d) => ({
      kind: "design", id: d.id, name: String(d.title || "ডিজাইন").slice(0, 80), price: Number(d.price) || 0,
      shopName: d.tailorName || "সেলাই ঘর", upazila: d.upazila || "", days: d.days || null, img: d.img || null,
    }));
  }

  /* ---------- 🍽️ রেস্টুরেন্ট ---------- */
  async function findRestaurants(action, area) {
    const all = await cached("rst", async () => {
      const qs = await db.collection("restaurants").where("isActive", "==", true).limit(60).get();
      return qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    });
    const words = cleanWords(action.words, action.query).filter((w) => !/^(রেস্টুরেন্ট|হোটেল|খাবার|restaurant)$/.test(w));
    let list = all.filter((r) => (!area.d || !r.district || r.district === area.d) && (!area.u || !r.upazila || r.upazila === area.u));
    if (words.length) {
      const w = list.filter((r) => scoreName((r.name || "") + " " + (r.cuisine || "") + " " + (r.tagline || ""), words) > 0);
      if (w.length) list = w;
    }
    return list.slice(0, 6).map((r) => ({ kind: "restaurant", id: r.id, name: String(r.name || "রেস্টুরেন্ট").slice(0, 80), upazila: r.upazila || "", img: r.logoUrl || r.coverUrl || null }));
  }

  /* ---------- 📦 আমার অর্ডার (শুধু নিজের, লগইন করা গ্রাহকের) ---------- */
  const ORD = { holding: "⏱️ অপেক্ষায়", pending: "🕐 দোকানের উত্তরের অপেক্ষায়", preparing: "📦 প্রস্তুত হচ্ছে", shipped: "🚚 পথে আছে", delivered: "✅ পৌঁছে গেছে", cancelled: "❌ বাতিল" };
  const TLR = { placed: "⏳ দর্জির উত্তরের অপেক্ষায়", accepted: "🔎 দর্জি নিয়েছেন", collecting: "🛵 রাইডার কাপড় নিতে আসছেন", stitching: "✂️ সেলাই চলছে", ready: "🎉 তৈরি", returning: "🛵 পোশাক নিয়ে আসছেন", delivered: "✅ পৌঁছে গেছে", declined: "❌ দর্জি নিতে পারেননি", cancelled: "✕ বাতিল" };
  async function myOrders(uid) {
    const [o, t] = await Promise.all([
      db.collection("orderRequests").where("customerUid", "==", uid).limit(40).get().catch(() => null),
      db.collection("tailorOrders").where("customerUid", "==", uid).limit(20).get().catch(() => null),
    ]);
    const rows = [];
    if (o) o.docs.forEach((d) => {
      const x = d.data() || {};
      rows.push({ kind: "order", sub: "shop", at: tsMs(x.createdAt), name: x.privateOrder ? "🔒 গোপনীয় পণ্য" : String(x.productName || "পণ্য").slice(0, 60),
        qty: Number(x.qty) || 1, status: ORD[x.status || "pending"] || String(x.status || ""), code: x.orderCode || null });
    });
    if (t) t.docs.forEach((d) => {
      const x = d.data() || {};
      rows.push({ kind: "order", sub: "tailor", at: tsMs(x.createdAt), name: "🧵 " + String(x.designTitle || "সেলাই").slice(0, 60),
        qty: Number(x.qty) || 1, status: TLR[x.status] || String(x.status || ""), code: x.orderCode || null });
    });
    rows.sort((a, b) => b.at - a.at);
    return rows.slice(0, 6);
  }

  /* ---------- কার্ড থেকে মৌ-এর নিজের বাক্য (দাম এখানে বসে, ডেটা থেকে) ---------- */
  const BN = "০১২৩৪৫৬৭৮৯";
  const bn = (v) => String(v).replace(/[0-9]/g, (d) => BN[d]);
  function money(n, cur) { return (cur || "৳") + bn(Math.round(Number(n) || 0).toLocaleString("en-IN")); }
  function summary(type, results, action, area) {
    const where = area.u || area.d ? (area.u || area.d) + " এলাকায়" : "বাজারে";
    const q = (Array.isArray(action.words) && action.words[0]) || action.query || "";
    if (type === "my_orders") {
      if (results === null) return "অর্ডারের খবর দেখতে আগে Google দিয়ে লগইন করুন বন্ধু। 🐝";
      if (!results.length) return "আপনার কোনো অর্ডার এখনো খুঁজে পেলাম না। 🐝";
      const r = results[0];
      return `আপনার শেষ অর্ডার "${r.name}" — এখন: ${r.status}। নিচে সবগুলো দেখুন। 🐝`;
    }
    if (!results.length) {
      if (type === "find_product") return `${where} এখন কোনো দোকানে "${q}" খুঁজে পেলাম না। 🐝 অন্য নামে লিখে দেখবেন?`;
      if (type === "find_tailor") return `${where} এমন দর্জির ডিজাইন এখন পেলাম না। 🐝 দাম বা ধরন একটু বদলে জিজ্ঞেস করুন।`;
      return `${where} এখন কোনো রেস্টুরেন্ট পেলাম না। 🐝`;
    }
    const r = results[0];
    if (type === "find_product") {
      const cheap = action.sort === "cheap" ? "সবচেয়ে কম দাম" : "পেয়েছি";
      const shops = new Set(results.map((x) => x.shopId)).size;
      return `${where} "${q}" — ${cheap}: ${r.shopName}, ${money(r.price, r.cur)}${r.unit ? "/" + r.unit : ""}। ${bn(shops)}টা দোকানের ${bn(results.length)}টা দাম নিচে দেখুন। 🐝`;
    }
    if (type === "find_tailor") return `${where} ${bn(results.length)}টা ডিজাইন পেলাম — মজুরি শুরু ${money(Math.min(...results.map((x) => x.price)))} থেকে। পছন্দেরটায় চাপ দিন। 🧵`;
    return `${where} ${bn(results.length)}টা রেস্টুরেন্ট পেলাম। 🍽️`;
  }

  async function run(action, ctx) {
    const area = cleanArea(ctx.area);
    const type = action && action.type;
    if (type === "find_product") return { type, area, results: await findProducts(action, area) };
    if (type === "find_tailor") return { type, area, results: await findDesigns(action, area) };
    if (type === "find_restaurant") return { type, area, results: await findRestaurants(action, area) };
    if (type === "my_orders") return { type, area, results: ctx.signedIn ? await myOrders(ctx.uid) : null };
    return null;
  }

  return { run, summary, _test: { norm, scoreName, cleanWords } };
};
