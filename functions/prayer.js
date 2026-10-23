/* ════════════ 🕌 নামাজ / সেহরি / ইফতারের নোটিফিকেশন ════════════
   ক্লায়েন্ট (honey-bee-bazar.html → নামাজ পাতা) লেখে:
     prayerSubs/{uid} = { token, lat, lon (২ দশমিক), area, on,
                          items: ["fajr","dhuhr","asr","maghrib","isha","sehri","iftar"],
                          before: ০/৫/১০/১৫ (মিনিট আগে), adj: -1|0|1 (চাঁদ), nextAt: এখন }
   prayerTick প্রতি ৫ মিনিটে চলে → শুধু যাদের nextAt পার হয়েছে তাদের ধরে:
     ১. আগে থেকে ঠিক করা নোটিফিকেশন (pending*) পাঠায় (২০ মিনিটের বেশি দেরি হলে বাদ)
     ২. পরের ঘটনাটা খুঁজে nextAt + pending* বসিয়ে রাখে
   সেহরি/ইফতার শুধু রমজান মাসে। সময় aladhan থেকে (অ্যাপের মতোই method=1, করাচি)।
   একই জায়গা-দিনের সময় prayerCache-এ রাখা হয়, যাতে বারবার বাইরে কল না যায়। */
module.exports = function ({ db, FieldValue, Timestamp, onSchedule, getMessaging }) {
  const BAZAR_URL = "https://honeybeebazar.com/honey-bee-bazar.html";
  const bn = (n) => Number(n).toLocaleString("bn-BD", { useGrouping: false });
  const NAME = { fajr: "ফজর", dhuhr: "যোহর", asr: "আসর", maghrib: "মাগরিব", isha: "এশা" };
  const KEY = { fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha" };
  const LATE_MS = 20 * 60 * 1000;

  /* IANA টাইমজোনে "HH:MM" → UTC মিলিসেকেন্ড */
  function tzOffsetMin(tz, atMs) {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const p = {}; f.formatToParts(new Date(atMs)).forEach((x) => { p[x.type] = x.value; });
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    return Math.round((asUtc - Math.floor(atMs / 60000) * 60000) / 60000);
  }
  function toMs(dmy, hhmm, tz) {
    const [d, m, y] = String(dmy).split("-").map(Number);
    const mt = String(hhmm || "").match(/(\d{1,2}):(\d{2})/); if (!mt) return null;
    const guess = Date.UTC(y, m - 1, d, +mt[1], +mt[2]);
    const off = tzOffsetMin(tz, guess);
    return guess - off * 60000;
  }
  const fmt12 = (ms, tz) => {
    const p = {}; new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    let h = +p.hour % 24; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
    return h + ":" + p.minute + " " + ap;
  };

  function localDmy(atMs, tz) {
    const p = {}; new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(atMs)).forEach((x) => { p[x.type] = x.value; });
    return p.day + "-" + p.month + "-" + p.year;
  }
  async function dayTimes(lat, lon, atMs, memo, tzHint) {
    const cell = lat.toFixed(2) + "_" + lon.toFixed(2);
    let tzq = "Asia/Dhaka"; try { new Intl.DateTimeFormat("en-US", { timeZone: tzHint }); if (tzHint) tzq = tzHint; } catch (e) {}
    const want = localDmy(atMs, tzq);
    const k = cell + "_" + want;
    if (memo.has(k)) return memo.get(k);
    const ref = db.collection("prayerCache").doc(k);
    const c = await ref.get();
    if (c.exists) { memo.set(k, c.data()); return c.data(); }
    const url = "https://api.aladhan.com/v1/timings/" + want + "?latitude=" + lat + "&longitude=" + lon + "&method=1";
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    let j;
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error("aladhan " + r.status); j = await r.json(); }
    finally { clearTimeout(t); }
    const D = j.data, tz = D.meta && D.meta.timezone || "Asia/Dhaka", dmy = D.date.gregorian.date;
    const out = { tz, dmy, hm: Number(D.date.hijri.month.number), hd: Number(D.date.hijri.day), at: {} };
    Object.keys(KEY).forEach((n) => { out.at[n] = toMs(dmy, D.timings[KEY[n]], tz); });
    out.expireAt = Timestamp.fromMillis(atMs + 3 * 864e5);
    await ref.set(out).catch(() => {});
    memo.set(k, out);
    return out;
  }

  /* চাঁদ (adj) ধরে রমজান কিনা — মাসের সীমায় আনুমানিক */
  function isRamadan(t, adj) {
    let d = t.hd - (adj || 0), m = t.hm;
    if (d < 1) m -= 1; else if (d > 30) m += 1;
    return m === 9;
  }

  /* now-এর পরের ঘটনা — আজ আর আগামীকাল দেখে */
  async function nextEvent(v, nowMs, memo) {
    const items = Array.isArray(v.items) ? v.items : [];
    const before = Math.max(0, Math.min(30, Number(v.before) || 0)) * 60000;
    const ev = [];
    for (const off of [0, 864e5, 2 * 864e5]) {
      const t = await dayTimes(v.lat, v.lon, nowMs + off, memo, v.tz);
      const ram = isRamadan(t, v.adj);
      Object.keys(NAME).forEach((n) => {
        const at = t.at[n]; if (!at) return;
        const iftarHere = n === "maghrib" && ram && items.includes("iftar");
        if (iftarHere) {
          ev.push({ at, key: t.dmy + ":iftar", title: "🌇 ইফতারের সময় হয়েছে — " + fmt12(at, t.tz),
            body: "রোজাদারদের ইফতার মোবারক 🤲" + (items.includes("maghrib") ? " মাগরিবের ওয়াক্তও শুরু।" : "") });
          return;
        }
        if (items.includes(n)) {
          ev.push({ at: at - before, key: t.dmy + ":" + n,
            title: "🕌 " + (before ? bn(before / 60000) + " মিনিট পর " + NAME[n] : NAME[n] + "-এর ওয়াক্ত শুরু হয়েছে"),
            body: NAME[n] + " — " + fmt12(at, t.tz) + (v.area ? " · 📍 " + v.area : "") });
        }
      });
      if (ram && items.includes("sehri") && t.at.fajr) {
        ev.push({ at: t.at.fajr - 30 * 60000, key: t.dmy + ":sehri", title: "🌄 সেহরির সময় শেষ হতে আর ৩০ মিনিট",
          body: "সেহরির শেষ সময় " + fmt12(t.at.fajr, t.tz) + " — সাবধানতার জন্য কয়েক মিনিট আগে খাওয়া শেষ করুন।" });
      }
      const fut = ev.filter((e) => e.at > nowMs + 30000).sort((a, b) => a.at - b.at);
      if (fut.length) return fut[0];
    }
    return null;
  }

  const prayerTick = onSchedule({ schedule: "every 5 minutes", timeZone: "UTC", timeoutSeconds: 240, memory: "256MiB" }, async () => {
    const nowMs = Date.now();
    const snap = await db.collection("prayerSubs").where("nextAt", "<=", Timestamp.fromMillis(nowMs)).limit(500).get();
    if (snap.empty) return;
    const memo = new Map();
    let sent = 0, planned = 0, failed = 0;
    for (const doc of snap.docs) {
      const v = doc.data();
      if (!v.on || !v.token || typeof v.lat !== "number" || typeof v.lon !== "number") { await doc.ref.update({ nextAt: FieldValue.delete() }).catch(() => {}); continue; }
      const due = v.nextAt && v.nextAt.toMillis ? v.nextAt.toMillis() : 0;
      // ১. ঠিক করে রাখা নোটিফিকেশন পাঠানো
      if (v.pendingKey && v.pendingTitle && nowMs - due < LATE_MS && v.lastKey !== v.pendingKey) {
        try {
          await getMessaging().send({
            token: v.token,
            notification: { title: v.pendingTitle, body: v.pendingBody || "" },
            data: { type: "prayer-alert", link: BAZAR_URL + "#prayer" },
            webpush: { headers: { Urgency: "high", TTL: "1200" }, fcmOptions: { link: BAZAR_URL + "#prayer" } },
          });
          sent++;
        } catch (e) {
          failed++;
          const code = e && e.code;
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            await doc.ref.update({ on: false, offReason: "token", nextAt: FieldValue.delete() }).catch(() => {});
            continue;
          }
        }
      }
      // ২. পরেরটা ঠিক করে রাখা
      try {
        const n = await nextEvent(v, nowMs, memo);
        const upd = { lastKey: v.pendingKey || null };
        if (n) Object.assign(upd, { nextAt: Timestamp.fromMillis(n.at), pendingKey: n.key, pendingTitle: n.title, pendingBody: n.body });
        else Object.assign(upd, { nextAt: Timestamp.fromMillis(nowMs + 6 * 3600 * 1000), pendingKey: null, pendingTitle: null, pendingBody: null });
        await doc.ref.update(upd);
        planned++;
      } catch (e) {
        console.warn(JSON.stringify({ event: "PRAYER_PLAN_FAIL", uid: doc.id, error: String(e && e.message || e) }));
        await doc.ref.update({ nextAt: Timestamp.fromMillis(nowMs + 15 * 60000) }).catch(() => {});
      }
    }
    console.log(JSON.stringify({ event: "PRAYER_TICK", due: snap.size, sent, planned, failed }));
  });

  return { prayerTick };
};
