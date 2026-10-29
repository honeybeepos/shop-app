/* =====================================================================
   💳 hb-billing.js — ব্যবসার "আমার হিসাব" (ক্রেডিট, সাবস্ক্রিপশন, কি, এজেন্ট)
   ---------------------------------------------------------------------
   দোকান/ফার্মেসি/রেস্টুরেন্ট/সেলাই ঘর/ট্রান্সপোর্ট — সব অ্যাপে একই ফাইল।
     HBBilling.mount(anchorEl, {before:true})  → ছোট "💳 ১২০" বোতাম বসায়
     HBBilling.open()                          → হিসাবের পাতা খোলে
     HBBilling.acceptOrders(orders)            → অনলাইন অর্ডার গ্রহণের আগে ফি (true/false)
     HBBilling.hiddenLine(o)                   → "📍 প্রায় ২.৩ কিমি · গ্রহণ করলে ২ ক্রেডিট"
   সুপার এডমিনের মূল সুইচ বন্ধ থাকলে কিছুই দেখায় না, কোনো ফাংশনও ডাকে না
   (শুধু একটা সেটিংস নথি পড়া)। ব্যতিক্রম: কেউ "কি"-এর লিংক নিয়ে এলে।
   ===================================================================== */
(function(){
  if(window.HBBilling) return;
  const BN = "০১২৩৪৫৬৭৮৯";
  const bn = (n)=> String(n).replace(/[0-9]/g, d=> BN[d]);
  const r2 = (n)=> Math.round(Number(n || 0) * 100) / 100;
  const esc = (v)=> String(v == null ? "" : v).replace(/[&<>"]/g, c=> ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const KEY_LS = "hb-pending-key";
  let st = null, cfg = null, pills = [], fnReady = null, started = false;

  // ?hbkey=… লিংক থেকে এলে মনে রাখা (লগইনের পরেও থাকে)
  try{
    const u = new URL(location.href), k = u.searchParams.get("hbkey");
    if(k){ localStorage.setItem(KEY_LS, k); u.searchParams.delete("hbkey"); history.replaceState(null, "", u.pathname + (u.search || "") + u.hash); }
  }catch(e){}
  const pendingKey = ()=>{ try{ return localStorage.getItem(KEY_LS) || ""; }catch(e){ return ""; } };

  function deviceId(){
    try{
      let d = localStorage.getItem("hb-device-id");
      if(!d){ d = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); localStorage.setItem("hb-device-id", d); }
      return d;
    }catch(e){ return ""; }
  }
  function loadFns(){
    if(fnReady) return fnReady;
    fnReady = new Promise((res, rej)=>{
      if(firebase.functions) return res();
      const s = document.createElement("script");
      s.src = "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions-compat.js";
      s.onload = ()=> res(); s.onerror = ()=>{ fnReady = null; rej(new Error("ইন্টারনেট সংযোগ দেখুন")); };
      document.head.appendChild(s);
    });
    return fnReady;
  }
  async function call(name, data){ await loadFns(); return (await firebase.functions().httpsCallable(name)(data)).data; }

  /* ---------- স্টাইল ---------- */
  const css = `
  .hbbPill{display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:9px;border:1px solid rgba(0,0,0,.12);background:#fff7e6;color:#5b3f12;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;white-space:nowrap;}
  .hbbPill.low{background:#fde8e4;color:#b42318;border-color:#f3b8ad;} .hbbPill.sub{background:#e6f6ee;color:#11734b;border-color:#a8dcc2;}
  #hbbOv{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147483000;display:none;align-items:flex-end;justify-content:center;font-family:'Noto Sans Bengali',system-ui,sans-serif;}
  #hbbOv.show{display:flex;}
  #hbbBox{background:#fffaf0;color:#2b2113;width:100%;max-width:460px;max-height:90vh;overflow:auto;border-radius:18px 18px 0 0;padding:18px 16px 22px;box-shadow:0 -8px 30px rgba(0,0,0,.3);}
  @media (min-width:700px){ #hbbOv{align-items:center;} #hbbBox{border-radius:18px;} }
  #hbbBox h3{margin:0 0 10px;font-size:16px;display:flex;justify-content:space-between;align-items:center;}
  #hbbBox h3 button{background:none;border:none;font-size:20px;cursor:pointer;color:#8b7f6c;}
  .hbbStrip{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;}
  .hbbS{background:#f6efe0;border:1px solid #eadcbd;border-radius:12px;padding:10px;}
  .hbbS small{display:block;font-size:11px;color:#8b7f6c;} .hbbS b{font-size:20px;} .hbbS.bad b{color:#b42318;} .hbbS.ok b{color:#11734b;}
  .hbbCard{border:1px solid #eadcbd;border-radius:12px;padding:11px 12px;margin-bottom:10px;background:#fff;font-size:13px;line-height:1.7;}
  .hbbCard b.t{display:block;font-size:13.5px;margin-bottom:2px;}
  .hbbBtns{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;} .hbbBtns a,.hbbBtns button{flex:1;min-width:90px;text-align:center;text-decoration:none;padding:9px 8px;border-radius:9px;font-weight:800;font-size:13px;border:1px solid #e3cf9f;background:#f5ecd9;color:#5b3f12;cursor:pointer;font-family:inherit;}
  .hbbBtns .wa{background:#25d366;color:#fff;border-color:#25d366;} .hbbBtns .go{background:#b8662f;color:#fff;border-color:#b8662f;}
  .hbbKey{display:flex;gap:6px;} .hbbKey input{flex:1;min-width:0;padding:10px;border-radius:9px;border:1px solid #d9c9a6;font-family:'Space Mono',monospace;font-size:15px;text-transform:uppercase;letter-spacing:1px;}
  .hbbMsg{font-size:12.5px;margin:6px 0 0;} .hbbRow{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px dashed #eadcbd;font-size:12.5px;}
  .hbbRow small{color:#8b7f6c;}
  .hbbToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#11734b;color:#fff;padding:12px 16px;border-radius:12px;font-weight:700;z-index:2147483001;font-family:'Noto Sans Bengali',sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:90vw;text-align:center;}`;
  function addCss(){ if(document.getElementById("hbbCss")) return; const s = document.createElement("style"); s.id = "hbbCss"; s.textContent = css; document.head.appendChild(s); }
  function toast(t, ms){ addCss(); const d = document.createElement("div"); d.className = "hbbToast"; d.textContent = t; document.body.appendChild(d); setTimeout(()=> d.remove(), ms || 4000); }

  function intl(p){ let d = String(p || "").replace(/[০-৯]/g, x=> BN.indexOf(x)).replace(/[^0-9]/g, ""); if(/^01\d{9}$/.test(d)) d = "88" + d; if(/^05\d{8}$/.test(d)) d = "966" + d.slice(1); return d; }
  function agentHtml(a, why){
    if(!a) return `<div class="hbbCard"><b class="t">🧑‍💼 আপনার এজেন্ট</b>এখনো কোনো এজেন্ট যুক্ত নেই।${st && st.contact && st.contact.phone ? ` Honey Bee: <b>${esc(st.contact.phone)}</b>` : ""}</div>`;
    const msg = encodeURIComponent(`আসসালামু আলাইকুম, আমি ${st && st.name ? st.name : "Honey Bee-র দোকান"} থেকে। ${why || "ক্রেডিট/সাবস্ক্রিপশন নিতে চাই।"}`);
    return `<div class="hbbCard"><b class="t">🧑‍💼 আপনার এজেন্ট — ক্রেডিট/সাবস্ক্রিপশন এখানে</b>${esc(a.name)}${a.phone ? " · <b>" + esc(a.phone) + "</b>" : ""}
      <div class="hbbBtns">${a.phone ? `<a href="tel:${esc(a.phone)}">📞 ফোন</a>` : ""}${a.whatsapp ? `<a class="wa" target="_blank" rel="noopener" href="https://wa.me/${intl(a.whatsapp)}?text=${msg}">💬 WhatsApp</a>` : ""}</div></div>`;
  }

  /* ---------- অবস্থা ---------- */
  async function refresh(){
    st = await call("billingShop", { action:"status", deviceId: deviceId() });
    if(st.justGifted) toast(`🎁 Honey Bee-র উপহার: ${bn(r2(st.credit))} ক্রেডিট আপনার হিসাবে যোগ হয়েছে!`, 6000);
    drawPills();
    return st;
  }
  function drawPills(){
    pills.forEach(p=>{
      if(!st || !st.on){ p.style.display = "none"; return; }
      p.style.display = "";
      if(st.subOnly || st.type === "driver" || st.type === "tailor"){ // 🚑🧵 শুধু সাবস্ক্রিপশন
        const dl = st.subUntil ? Math.ceil((st.subUntil - Date.now()) / 86400000) : 0;
        p.className = "hbbPill" + (st.subActive ? (dl <= 3 ? " low" : " sub") : " low");
        p.textContent = st.subActive ? "📅 " + bn(dl) + " দিন" : "📅 সাবস্ক্রিপশন নেই";
        p.title = "আমার হিসাব — সাবস্ক্রিপশন"; return;
      }
      const low = !st.subActive && st.credit < Math.max(2, (st.prices && st.prices.orderFee) || 0);
      p.className = "hbbPill" + (st.subActive ? " sub" : low ? " low" : "");
      p.textContent = st.subActive ? "💳 " + bn(r2(st.credit)) + " · 📅" : "💳 " + bn(r2(st.credit));
      p.title = "আমার হিসাব — ক্রেডিট ও সাবস্ক্রিপশন";
    });
  }
  let startP = null;
  function start(){ if(!startP) startP = start0(); return startP; }
  async function start0(){
    if(started) return; started = true;
    try{
      const d = await firebase.firestore().collection("billingConfig").doc("main").get();
      cfg = d.exists ? d.data() : null;
    }catch(e){ cfg = null; }
    const on = cfg && cfg.enabled;
    if(!on && !pendingKey()) return;
    try{ await refresh(); }catch(e){ console.warn("billing status", e); }
    if(pendingKey()) open();
  }
  function whenAuthed(){
    try{
      firebase.auth().onAuthStateChanged((u)=>{ if(u && !u.isAnonymous) start(); });
    }catch(e){}
  }

  /* ---------- হিসাবের পাতা ---------- */
  function shell(){
    addCss();
    let ov = document.getElementById("hbbOv");
    if(!ov){
      ov = document.createElement("div"); ov.id = "hbbOv";
      ov.innerHTML = `<div id="hbbBox"></div>`;
      ov.addEventListener("click", (e)=>{ if(e.target === ov) ov.classList.remove("show"); });
      document.body.appendChild(ov);
    }
    return ov;
  }
  async function open(){
    const ov = shell(), box = document.getElementById("hbbBox");
    ov.classList.add("show");
    box.innerHTML = `<h3>💳 আমার হিসাব <button aria-label="বন্ধ">✕</button></h3><p class="hbbMsg">লোড হচ্ছে...</p>`;
    box.querySelector("h3 button").onclick = ()=> ov.classList.remove("show");
    try{ await refresh(); }catch(e){ box.querySelector(".hbbMsg").textContent = "⚠️ " + (e.message || e); }
    draw();
  }
  function draw(){
    const box = document.getElementById("hbbBox"); if(!box || !st) return;
    const cur = st.country === "SA" ? "রিয়াল" : "৳", p = st.prices || {};
    const until = st.subUntil ? new Date(st.subUntil).toLocaleDateString("bn-BD", { day:"numeric", month:"long", year:"numeric" }) : "";
    const days = st.subUntil ? Math.ceil((st.subUntil - Date.now()) / 86400000) : 0;
    box.innerHTML = `<h3>💳 আমার হিসাব <button aria-label="বন্ধ">✕</button></h3>
      <div class="hbbStrip">
        ${st.subOnly ? "" : `<div class="hbbS ${st.credit <= 0 ? "bad" : "ok"}"><small>বাকি ক্রেডিট</small><b>${bn(r2(st.credit))}</b></div>`}
        <div class="hbbS ${st.subActive ? "ok" : "bad"}"${st.subOnly ? ' style="grid-column:1 / -1;"' : ""}><small>📅 সাবস্ক্রিপশন</small><b style="font-size:${st.subActive ? 14 : 16}px;">${st.subActive ? until + "<br><small>" + bn(days) + " দিন বাকি</small>" : "নেই"}</b></div>
      </div>
      ${st.on && (st.type === "driver" || st.type === "tailor") ? `<div class="hbbCard"><b class="t">📋 নিয়ম</b>
        ${st.type === "tailor"
          ? "🧵 সাবস্ক্রিপশন চালু থাকলে Honey Bee Bazar-এ আপনার ডিজাইন, নম্বর আর অনলাইন অর্ডার গ্রাহকরা দেখবেন। নিজের খাতা আর মাপ সবসময় ফ্রি।" + (st.subActive ? "" : "<br><b style='color:#b42318'>🔴 এখন সাবস্ক্রিপশন নেই — বাজারে আপনার ডিজাইন দেখা যাচ্ছে না।</b>")
          : "🚑 সাবস্ক্রিপশন চালু থাকলে অনলাইন হয়ে যাত্রীর ডাক পাবেন — প্রতি ট্রিপে কিছু কাটে না।"}<br>
        📅 ${[1,3,6,12].map(m=> bn(m) + " মাস " + bn((p.sub || {})["m"+m] || 0) + " " + cur).join(" · ")}</div>`
      : st.on ? `<div class="hbbCard"><b class="t">📋 কীভাবে কাটে</b>
        🧾 দোকানে প্রতি বিক্রিতে: <b>${bn(p.perSale)} ক্রেডিট</b>${st.subActive ? " — <b style='color:#11734b'>এখন ফ্রি (সাবস্ক্রিপশন চালু)</b>" : ""}<br>
        🛒 অনলাইন অর্ডার গ্রহণে: <b>${bn(p.orderFee)} ক্রেডিট</b> (সবসময়)<br>
        📅 সাবস্ক্রিপশন নিলে দোকানে বিক্রি ফ্রি: ${[1,3,6,12].map(m=> bn(m) + " মাস " + bn((p.sub || {})["m"+m] || 0) + " " + cur).join(" · ")}</div>` : `<div class="hbbCard">এখন Honey Bee-তে কোনো চার্জ কাটছে না।</div>`}
      ${st.giftOn && st.giftGiven ? `<div class="hbbCard" style="background:#fff7e0;">🎁 আপনি Honey Bee-র স্বাগত উপহার পেয়েছেন: <b>${bn(r2(st.giftCredit))} ক্রেডিট</b>। শেষ হলে এজেন্টের কাছ থেকে কিনুন।</div>` : ""}
      ${agentHtml(st.agent)}
      <div class="hbbCard"><b class="t">🔑 এজেন্টের পাঠানো কি বসান</b>
        <div class="hbbKey"><input id="hbbKeyIn" placeholder="HB-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" value="${esc(pendingKey())}"><button class="go" id="hbbKeyGo" style="flex:0 0 auto; padding:9px 14px; border-radius:9px; border:none; background:#b8662f; color:#fff; font-weight:800; font-family:inherit; cursor:pointer;">বসান</button></div>
        <p class="hbbMsg" id="hbbKeyMsg" style="display:none;"></p></div>
      <div class="hbbCard"><b class="t">🧾 সাম্প্রতিক হিসাব</b><div id="hbbLed">লোড হচ্ছে...</div></div>`;
    box.querySelector("h3 button").onclick = ()=> document.getElementById("hbbOv").classList.remove("show");
    document.getElementById("hbbKeyGo").onclick = redeem;
    if(pendingKey()) document.getElementById("hbbKeyIn").focus();
    ledger();
  }
  async function ledger(){
    const el = document.getElementById("hbbLed"); if(!el || !st) return;
    const K = { agent:"🧑‍💼 এজেন্ট দিলেন", key:"🔑 কি", gift:"🎁 উপহার", correction:"✏️ সংশোধন", sale:"🧾 বিক্রি", order:"🛒 অনলাইন অর্ডার", refund:"↩️ ফেরত", sub:"📅 সাবস্ক্রিপশন" };
    try{
      const s = await firebase.firestore().collection("billing").doc(st.bizId).collection("ledger").orderBy("at","desc").limit(15).get();
      el.innerHTML = s.empty ? "<small>এখনো কিছু নেই</small>" : s.docs.map(d=>{ const l = d.data(); const t = l.at && l.at.toDate ? l.at.toDate().toLocaleString("bn-BD", { day:"numeric", month:"short", hour:"numeric", minute:"2-digit" }) : "";
        const v = l.months ? `<b style="color:#11734b">+${bn(l.months)} মাস</b>` : `<b style="color:${l.amount < 0 ? "#b42318" : "#11734b"}">${l.amount < 0 ? "−" : "+"}${bn(Math.abs(r2(l.amount)))}</b>`;
        return `<div class="hbbRow"><span>${K[l.kind] || l.kind}${l.note ? " — " + esc(l.note) : ""}<br><small>${t}</small></span><span style="text-align:right;white-space:nowrap;">${v}<br><small>বাকি ${bn(r2(l.balanceAfter))}</small></span></div>`; }).join("");
    }catch(e){ el.innerHTML = "<small>দেখা যাচ্ছে না</small>"; }
  }
  async function redeem(){
    const inp = document.getElementById("hbbKeyIn"), msg = document.getElementById("hbbKeyMsg"), btn = document.getElementById("hbbKeyGo");
    const key = inp.value.trim(); if(!key) return;
    btn.disabled = true; msg.style.display = "none";
    try{
      const r = await call("billingShop", { action:"redeem", key });
      try{ localStorage.removeItem(KEY_LS); }catch(e){}
      toast(r.months ? `✅ ${bn(r.months)} মাসের সাবস্ক্রিপশন চালু হয়েছে` : `✅ ${bn(r.amount)} ক্রেডিট যোগ হয়েছে`, 5000);
      await refresh(); draw();
    }catch(e){
      msg.textContent = "⚠️ " + (e.message || e); msg.style.color = "#b42318"; msg.style.display = "block"; btn.disabled = false;
      if(/সঠিক নয়|অন্য/.test(String(e.message))) try{ localStorage.removeItem(KEY_LS); }catch(x){}
    }
  }

  /* ---------- অনলাইন অর্ডার গ্রহণ ---------- */
  function hiddenLine(o){
    if(!o || !o.contactHidden || o.feePaid) return "";
    const km = o.approxKm != null ? "প্রায় " + bn(o.approxKm) + " কিমি দূরে" : "দূরত্ব জানা নেই";
    return `📍 ${km} · গ্রহণ করলে ${bn(o.feeAmount || 0)} ক্রেডিট কাটবে, তারপর গ্রাহকের নাম-ফোন-ঠিকানা দেখা যাবে`;
  }
  async function acceptOrders(orders){
    const list = (orders || []).filter(o=> o && o.contactHidden && !o.feePaid);
    if(!list.length) return true;
    // একই রসিদের সব পণ্য একসাথে — orderCode আলাদা হলে প্রতিটার জন্য
    const seen = new Set();
    for(const o of list){
      const k = o.orderCode || o.id; if(seen.has(k)) continue; seen.add(k);
      let r;
      try{ r = await call("orderAccept", { orderId: o.id }); }
      catch(e){ alert("⚠️ গ্রহণ করা যায়নি: " + (e.message || e)); return false; }
      if(!r.ok && r.reason === "low_credit"){ lowCredit(r); return false; }
      if(!r.ok){ alert("⚠️ গ্রহণ করা যায়নি"); return false; }
    }
    if(st) refresh().catch(()=>{});
    return true;
  }
  function lowCredit(r){
    const ov = shell(), box = document.getElementById("hbbBox");
    ov.classList.add("show");
    box.innerHTML = `<h3>💳 ক্রেডিট দিন <button aria-label="বন্ধ">✕</button></h3>
      <div class="hbbCard" style="background:#fde8e4;border-color:#f3b8ad;">এই অর্ডার গ্রহণ করতে <b>${bn(r.fee)} ক্রেডিট</b> লাগবে, আপনার আছে <b>${bn(r2(r.credit))}</b>।<br>এজেন্টের কাছ থেকে ক্রেডিট নিয়ে আবার "গ্রহণ" চাপুন — অর্ডারটা অপেক্ষায় থাকবে।</div>
      ${agentHtml(r.agent, "অনলাইন অর্ডার এসেছে, ক্রেডিট লাগবে।")}
      <div class="hbbBtns"><button class="go" id="hbbOpenAcc">🔑 কি আছে? বসান</button></div>`;
    box.querySelector("h3 button").onclick = ()=> ov.classList.remove("show");
    document.getElementById("hbbOpenAcc").onclick = open;
  }

  /* 🚑 চালক অনলাইন হওয়ার আগে — সাবস্ক্রিপশন লাগলে আর না থাকলে false (পাতা খুলে দেখায়) */
  async function canGoOnline(){
    try{ await start(); }catch(e){}
    if(!st || !st.on || st.type !== "driver" || st.subActive) return true;
    await open();
    const box = document.getElementById("hbbBox");
    if(box){ const n = document.createElement("div"); n.className = "hbbCard"; n.style.cssText = "background:#fde8e4;border-color:#f3b8ad;";
      n.innerHTML = "🔴 অনলাইন হতে সাবস্ক্রিপশন লাগবে। এজেন্টের কাছ থেকে নিন, বা এজেন্টের পাঠানো কি নিচে বসান।";
      box.insertBefore(n, box.children[1] || null); }
    return false;
  }

  function mount(anchor, opt){
    if(!anchor) return;
    addCss();
    const b = document.createElement("button"); b.type = "button"; b.className = "hbbPill"; b.style.display = "none";
    b.onclick = open;
    if(opt && opt.style) b.setAttribute("style", b.getAttribute("style") + ";" + opt.style);
    if(opt && opt.inside) anchor.appendChild(b); else anchor.parentNode.insertBefore(b, opt && opt.after ? anchor.nextSibling : anchor);
    pills.push(b); drawPills();
    return b;
  }

  window.HBBilling = { mount, open, acceptOrders, hiddenLine, refresh, canGoOnline, state: ()=> st, _whenAuthed: whenAuthed };
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", whenAuthed); else whenAuthed();
})();
