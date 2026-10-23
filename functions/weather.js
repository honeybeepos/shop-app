/* ════════════ 🌦️ আবহাওয়ার আগাম সতর্কতা — ফোনে নোটিফিকেশন ════════════
   ক্লায়েন্ট (honey-bee-bazar.html → আবহাওয়া প্যানেল) চালু করলে লেখে:
     weatherSubs/{uid} = { token, lat, lon (২ দশমিক — প্রায় ১ কিমি), area,
                           on, mode: "eve" | "morn", utcHour }
   wxAlertTick প্রতি ঘণ্টায় চলে → যাদের utcHour এখন, তাদের এলাকার পূর্বাভাস
   Open-Meteo থেকে আনে (কাছাকাছি লোকেরা এক কলেই) → খারাপ আবহাওয়া থাকলে পুশ।
     eve  = রাতে (যেমন ৮টা) আগামীকালের খবর
     morn = সকালে (যেমন ৭টা) আজকের খবর
   একই দিনের খবর একজনকে একবারই যায় (lastSent)। সব ঠিক থাকলে কিছুই যায় না।
   ⚠️ এটা মডেলের সম্ভাবনা, সরকারি বিপদ সংকেত নয় — নোটিফিকেশনেও তা-ই বলা হয় না। */
module.exports = function ({ db, FieldValue, onSchedule, getMessaging }) {
  const BAZAR_URL = "https://honeybeebazar.com/honey-bee-bazar.html";
  const bn = (n) => Number(n).toLocaleString("bn-BD");
  const WD = ["রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার"];
  const STORM = [95, 96, 99];

  function hourBn(h) {
    const part = h < 4 ? "রাত" : h < 6 ? "ভোর" : h < 12 ? "সকাল" : h < 15 ? "দুপুর" : h < 18 ? "বিকেল" : h < 20 ? "সন্ধ্যা" : "রাত";
    let h12 = h % 12; if (h12 === 0) h12 = 12;
    return part + " " + bn(h12) + "টা";
  }
  function windowText(H, ds, test, fromHour) {
    const hrs = [];
    (H.time || []).forEach((t, k) => {
      if (String(t).slice(0, 10) !== ds) return;
      const h = Number(String(t).slice(11, 13));
      if (fromHour != null && h < fromHour) return;
      if (test(k)) hrs.push(h);
    });
    if (!hrs.length) return "";
    const a = hrs[0], b = hrs[hrs.length - 1] + 1;
    return a === b - 1 ? hourBn(a) + " নাগাদ" : hourBn(a) + " থেকে " + hourBn(Math.min(b, 23)) + " পর্যন্ত";
  }

  /* একটা দিনের সতর্কতা — ক্লায়েন্টের hbWxAlerts-এর একই নিয়ম */
  function dayAlerts(data, i, fromHour) {
    const D = data.daily || {}, H = data.hourly || {}, ds = (D.time || [])[i], out = [];
    if (!ds) return out;
    const inDay = (k) => String(H.time[k]).slice(0, 10) === ds && (fromHour == null || Number(String(H.time[k]).slice(11, 13)) >= fromHour);
    const code = (D.weathercode || [])[i], prob = (D.precipitation_probability_max || [])[i] || 0,
      rain = (D.precipitation_sum || [])[i] || 0, gust = (D.windgusts_10m_max || [])[i] || 0, tmax = (D.temperature_2m_max || [])[i];
    if (fromHour != null) {
      const left = (H.time || []).some((t, k) => inDay(k) && ((H.precipitation_probability || [])[k] >= 50 || STORM.includes((H.weathercode || [])[k]) || (H.windgusts_10m || [])[k] >= 40));
      if (!left && !(tmax >= 37)) return out;
    }
    if (STORM.includes(code) || (H.weathercode || []).some((c, k) => STORM.includes(c) && inDay(k))) {
      const w = windowText(H, ds, (k) => STORM.includes(H.weathercode[k]), fromHour);
      out.push({ lv: 3, icon: "⛈️", title: "বজ্রঝড়ের সম্ভাবনা", text: (w ? w + "। " : "") + "খোলা মাঠ, গাছের নিচে ও পানিতে থাকবেন না। জরুরি কাজ আগে সেরে নিন।" });
    }
    if (gust >= 40) {
      const w = windowText(H, ds, (k) => (H.windgusts_10m || [])[k] >= 40, fromHour);
      out.push({ lv: gust >= 60 ? 3 : 2, icon: "🌬️", title: (gust >= 60 ? "ঝড়ো হাওয়া" : "দমকা হাওয়া") + " — ঘণ্টায় " + bn(Math.round(gust)) + " কিমি", text: (w ? w + "। " : "") + "টিনের চাল, সাইনবোর্ড, খামারের শেড বেঁধে রাখুন।" });
    }
    if (prob >= 50 || rain >= 10) {
      const heavy = rain >= 50, mid = rain >= 20 || prob >= 80;
      const w = windowText(H, ds, (k) => (H.precipitation_probability || [])[k] >= 50, fromHour);
      out.push({ lv: heavy ? 3 : mid ? 2 : 1, icon: heavy ? "🌧️" : "🌦️", title: heavy ? "ভারী বৃষ্টির সম্ভাবনা" : "বৃষ্টির সম্ভাবনা " + bn(Math.round(prob)) + "%", text: (w ? w + "। " : "") + (heavy ? "পানি জমতে পারে — ফসল, পুকুর, মালামাল সামলে রাখুন।" : "বাইরের কাজ আগেভাগে শেষ করুন, ছাতা সাথে রাখুন।") });
    }
    if (tmax != null && tmax >= 37) {
      out.push({ lv: tmax >= 40 ? 3 : 2, icon: "🔥", title: "তীব্র গরম — " + bn(Math.round(tmax)) + "°", text: "দুপুরে রোদে কাজ এড়ান, বেশি পানি পান করুন। পশু-পাখিকে ছায়া ও পানি দিন।" });
    }
    if ([45, 48].includes(code)) out.push({ lv: 1, icon: "🌫️", title: "ঘন কুয়াশা", text: "ভোরে রাস্তায় সাবধানে চলুন।" });
    return out.sort((a, b) => b.lv - a.lv);
  }

  async function forecast(lat, lon) {
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
      "&daily=temperature_2m_max,weathercode,precipitation_probability_max,precipitation_sum,windgusts_10m_max" +
      "&hourly=precipitation_probability,weathercode,windgusts_10m&forecast_days=3&timezone=auto";
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("open-meteo " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  const wxAlertTick = onSchedule({ schedule: "every 60 minutes", timeZone: "UTC", timeoutSeconds: 300, memory: "256MiB" }, async () => {
    const nowH = new Date().getUTCHours();
    const snap = await db.collection("weatherSubs").where("on", "==", true).where("utcHour", "==", nowH).limit(2000).get();
    if (snap.empty) return;
    // কাছাকাছি (≈২৫ কিমি ঘর) লোকের জন্য একটাই পূর্বাভাস কল
    const cells = new Map();
    snap.forEach((d) => {
      const v = d.data();
      if (!v.token || typeof v.lat !== "number" || typeof v.lon !== "number") return;
      const key = (Math.round(v.lat * 4) / 4) + "," + (Math.round(v.lon * 4) / 4);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push({ id: d.id, ref: d.ref, v });
    });
    let sent = 0, skipped = 0, failed = 0;
    for (const [key, subs] of cells) {
      let data;
      try { const [la, lo] = key.split(","); data = await forecast(la, lo); }
      catch (e) { console.warn(JSON.stringify({ event: "WX_FETCH_FAIL", key, error: String(e && e.message || e) })); continue; }
      const off = Number(data.utc_offset_seconds || 0);
      const local = new Date(Date.now() + off * 1000), localH = local.getUTCHours();
      for (const s of subs) {
        const eve = s.v.mode !== "morn";
        const idx = eve ? 1 : 0, ds = (data.daily && data.daily.time || [])[idx];
        if (!ds) continue;
        const stamp = ds + ":" + (eve ? "eve" : "morn");
        if (s.v.lastSent === stamp) { skipped++; continue; }
        const al = dayAlerts(data, idx, eve ? null : localH);
        if (!al.length) continue;
        const d = new Date(ds + "T12:00:00Z");
        const when = eve ? "আগামীকাল (" + WD[d.getUTCDay()] + ")" : "আজ";
        const top = al[0];
        const title = top.icon + " " + when + " " + top.title;
        const body = top.text + (al.length > 1 ? " · আরও: " + al.slice(1).map((a) => a.icon + " " + a.title).join(", ") : "") + (s.v.area ? " · 📍 " + s.v.area : "");
        try {
          await getMessaging().send({
            token: s.v.token,
            notification: { title, body: body.slice(0, 900) },
            data: { type: "weather-alert", link: BAZAR_URL + "#weather" },
            webpush: { headers: { Urgency: top.lv >= 3 ? "high" : "normal" }, fcmOptions: { link: BAZAR_URL + "#weather" } },
          });
          await s.ref.update({ lastSent: stamp, lastSentAt: FieldValue.serverTimestamp() });
          sent++;
        } catch (e) {
          failed++;
          const code = e && e.code;
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
            await s.ref.update({ on: false, offReason: "token" }).catch(() => {});
          }
        }
      }
    }
    console.log(JSON.stringify({ event: "WX_TICK", hour: nowH, subs: snap.size, cells: cells.size, sent, skipped, failed }));
  });

  return { wxAlertTick };
};
