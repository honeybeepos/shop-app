/* ============================================================
   🚚 ডেলিভারি চার্জ ইঞ্জিন (অক্টোবর ২০২৬)
   ============================================================
   সব দোকান/রেস্টুরেন্ট এই একটাই হিসাব ব্যবহার করে। চার্জের নিয়ম আসে
   deliveryPricing/{marketId} থেকে (এজেন্ট প্যানেলে সেট করা)।

   দূরত্ব:
     · দোকান      → দোকানের নিজের GPS (shops/{id}.storeLocation) থেকে ক্রেতা
     · রেস্টুরেন্ট → restaurants/{id}.storeLocation থেকে ক্রেতা
   ডেলিভারি দল (group):
     · একই বাজারের কয়েক দোকান = একটা দল = একজন রাইডার = একটা চার্জ।
       দূরত্ব ধরা হয় দলের মধ্যে ক্রেতা থেকে সবচেয়ে দূরের দোকানটা।
     · প্রতিটা রেস্টুরেন্ট আলাদা দল।
   রাতের চার্জ: অর্ডার তৈরির মুহূর্তের বাংলাদেশ সময় দেখে।

   ⚠️ calcCharge() হুবহু honey-bee-agent.html-এর dpCalcCharge()-এর মতো।
      একটা বদলালে অন্যটাও বদলাতে হবে।
   ============================================================ */

const DP_DEFAULTS = {
  tiers: [ { upToKm: 1, charge: 20 }, { upToKm: 2, charge: 25 }, { upToKm: 3, charge: 30 },
           { upToKm: 4, charge: 35 }, { upToKm: 5, charge: 40 } ],
  extraPerKm: 5, minCharge: 20, maxDistanceKm: 10,
  night: { enabled: false, amount: 0, start: "22:30", end: "08:00" },
  allowApprox: false, roadFactor: 1.3,
  rider: { baseCharge: 0, perKmRate: 0 },
};
const PRICING_TIMEZONE = "Asia/Dhaka";
const ROUTE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // রাস্তা রোজ বদলায় না — ৩০ দিন

function mergeConfig(saved) {
  const d = JSON.parse(JSON.stringify(DP_DEFAULTS));
  if (!saved) return d;
  if (Array.isArray(saved.tiers) && saved.tiers.length) d.tiers = saved.tiers;
  ["extraPerKm", "minCharge", "maxDistanceKm", "allowApprox", "roadFactor"].forEach((k) => {
    if (saved[k] != null) d[k] = saved[k];
  });
  if (saved.night) Object.assign(d.night, saved.night);
  if (saved.rider) Object.assign(d.rider, saved.rider);
  return d;
}

/* দূরত্ব (মিটার) → চার্জের ভাগ */
function calcCharge(cfg, meters, isNight) {
  const m = Math.max(0, Math.round(meters));
  const tiers = cfg.tiers.slice().sort((a, b) => a.upToKm - b.upToKm);
  let dist = null;
  for (const t of tiers) { if (m <= Math.round(t.upToKm * 1000)) { dist = t.charge; break; } }
  if (dist === null) {
    const last = tiers[tiers.length - 1];
    const extraKm = Math.ceil((m - Math.round(last.upToKm * 1000)) / 1000);
    dist = last.charge + extraKm * cfg.extraPerKm;
  }
  dist = Math.max(cfg.minCharge, dist);
  const night = (isNight && cfg.night.enabled) ? cfg.night.amount : 0;
  const tooFar = m > Math.round(cfg.maxDistanceKm * 1000);
  return { distanceCharge: dist, nightSurcharge: night, total: dist + night, tooFar };
}

/* "22:30" → ১৩৫০ মিনিট */
function hhmmToMin(s, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!m) return fallback;
  return (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60);
}

/* বাংলাদেশ সময়ে রাত কিনা। শুরু > শেষ হলে মাঝরাত পেরোনো সময় (যেমন ২২:৩০–০৮:০০)। */
function isNightAt(cfg, date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PRICING_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const mi = Number(parts.find((p) => p.type === "minute").value);
  const now = h * 60 + mi;
  const start = hhmmToMin(cfg.night.start, 22 * 60 + 30);
  const end = hhmmToMin(cfg.night.end, 8 * 60);
  if (start === end) return false;
  return start > end ? (now >= start || now < end) : (now >= start && now < end);
}

function validLatLng(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && isFinite(lat) && isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/* deps = { db, haversineKm, getRoadDistanceKm } — index.js থেকে দেওয়া হয় */
module.exports = function makeDeliveryPricing(deps) {
  const { db, haversineKm, getRoadDistanceKm } = deps;

  /* দোকান নাকি রেস্টুরেন্ট — দুই ঘরেই খোঁজা */
  async function loadSource(id) {
    const s = await db.collection("shops").doc(id).get();
    if (s.exists) {
      const d = s.data();
      return { id, type: "shop", name: d.name || d.shopName || "দোকান", marketId: d.marketId || null, loc: d.storeLocation || null };
    }
    const r = await db.collection("restaurants").doc(id).get();
    if (r.exists) {
      const d = r.data();
      return { id, type: "restaurant", name: d.name || "রেস্টুরেন্ট", marketId: d.marketId || null, loc: d.storeLocation || null };
    }
    return { id, type: "unknown", name: "অজানা", marketId: null, loc: null };
  }

  const configCache = {};
  async function loadConfig(marketId) {
    if (!marketId) return { cfg: mergeConfig(null), version: 0 };
    if (configCache[marketId]) return configCache[marketId];
    const snap = await db.collection("deliveryPricing").doc(marketId).get();
    const saved = snap.exists ? snap.data() : null;
    const out = { cfg: mergeConfig(saved), version: (saved && saved.version) || 0 };
    configCache[marketId] = out;
    return out;
  }

  /* এক উৎস থেকে ক্রেতা পর্যন্ত রাস্তার দূরত্ব (মিটার) */
  async function routeMeters(src, dest, cfg) {
    const r = await getRoadDistanceKm(src.loc.lat, src.loc.lng, dest.lat, dest.lng, ROUTE_CACHE_TTL_MS);
    if (r && r.source !== "haversine-fallback" && r.distanceKm != null) {
      return { meters: Math.round(r.distanceKm * 1000), approximate: false };
    }
    // Google পাওয়া যায়নি — এজেন্ট অনুমতি দিলে তবেই আনুমানিক
    if (cfg.allowApprox) {
      const km = haversineKm(src.loc.lat, src.loc.lng, dest.lat, dest.lng) * (cfg.roadFactor || 1.3);
      return { meters: Math.round(km * 1000), approximate: true };
    }
    return null;
  }

  /* মূল হিসাব। sourceIds = কার্টের দোকান/রেস্টুরেন্ট id, dest = {lat,lng}, at = অর্ডারের সময়।
     ফেরত: { ok, status, groups: [...], totalCharge } */
  async function computeQuote(sourceIds, dest, at) {
    const ids = [...new Set((sourceIds || []).filter((x) => typeof x === "string" && x))].slice(0, 20);
    if (!ids.length) return { ok: false, status: "no_items", groups: [], totalCharge: 0 };
    if (!dest || !validLatLng(dest.lat, dest.lng)) {
      return { ok: false, status: "no_destination", groups: [], totalCharge: 0 };
    }
    const sources = await Promise.all(ids.map(loadSource));

    // দল বানানো
    const groupsByKey = {};
    sources.forEach((s) => {
      const key = s.type === "shop" && s.marketId ? "m:" + s.marketId : (s.type === "restaurant" ? "r:" : "s:") + s.id;
      (groupsByKey[key] = groupsByKey[key] || { key, marketId: s.marketId, type: s.type, sources: [] }).sources.push(s);
    });

    const groups = [];
    for (const g of Object.values(groupsByKey)) {
      const { cfg, version } = await loadConfig(g.marketId);
      const out = {
        groupKey: g.key, type: g.type, marketId: g.marketId || null,
        sourceIds: g.sources.map((s) => s.id), sourceNames: g.sources.map((s) => s.name),
        pricingVersion: version, status: "ok",
        distanceMeters: null, approximate: false, farthestSourceId: null,
        distanceCharge: 0, nightSurcharge: 0, total: 0,
      };
      const missing = g.sources.filter((s) => !s.loc || !validLatLng(s.loc.lat, s.loc.lng));
      if (missing.length) {
        out.status = "no_source_location";
        out.missingNames = missing.map((s) => s.name);
        groups.push(out); continue;
      }
      let farthest = null, anyApprox = false, failed = false;
      for (const s of g.sources) {
        const r = await routeMeters(s, dest, cfg);
        if (!r) { failed = true; break; }
        if (r.approximate) anyApprox = true;
        if (!farthest || r.meters > farthest.meters) farthest = { meters: r.meters, id: s.id };
      }
      if (failed) { out.status = "route_unavailable"; groups.push(out); continue; }

      const c = calcCharge(cfg, farthest.meters, isNightAt(cfg, at || new Date()));
      Object.assign(out, {
        distanceMeters: farthest.meters, farthestSourceId: farthest.id, approximate: anyApprox,
        distanceCharge: c.distanceCharge, nightSurcharge: c.nightSurcharge, total: c.total,
        status: c.tooFar ? "too_far" : "ok", maxDistanceKm: cfg.maxDistanceKm,
      });
      groups.push(out);
    }
    const allOk = groups.every((g) => g.status === "ok");
    const firstBad = groups.find((g) => g.status !== "ok");
    return {
      ok: allOk, status: allOk ? "ok" : firstBad.status, groups,
      totalCharge: groups.reduce((a, g) => a + (g.status === "ok" ? g.total : 0), 0),
      timezone: PRICING_TIMEZONE,
    };
  }

  return { computeQuote, calcCharge, isNightAt, mergeConfig, validLatLng };
};

module.exports.DP_DEFAULTS = DP_DEFAULTS;
module.exports.calcCharge = calcCharge;
module.exports.isNightAt = isNightAt;
module.exports.mergeConfig = mergeConfig;
