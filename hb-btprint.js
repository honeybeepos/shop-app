/* 🔵🖨️ Honey Bee — ব্লুটুথ থার্মাল প্রিন্ট (RawBT দিয়ে), সব অ্যাপের জন্য একই কোড
   ------------------------------------------------------------------------------
   দোকানের POS-এ (shop-ledger-app.html) যে পদ্ধতি চলছে, হুবহু সেটাই:
   রসিদটা প্রথমে বাংলা ফন্টে একটা ছবি (canvas) হিসেবে আঁকা হয়, তারপর ESC/POS-এর
   "GS v 0" ছবি-কমান্ড বানিয়ে Android-এর intent: লিংকে RawBT অ্যাপে পাঠানো হয়।
   এতে সস্তা প্রিন্টারেও বাংলা অক্ষর ভাঙে না।

   ব্যবহার:
     HBBT.printElement(el, { paper:"58" | "80" })   — পাতায় থাকা রসিদের অংশ
     HBBT.printHtml(html, { paper })                — শুধু HTML লেখা থেকে
   paper না দিলে localStorage-এর "hb-paper" (POS-এর সেটিং) দেখে; না থাকলে ৫৮mm।
   ৫৮mm = ৩৮৪ ডট, ৮০mm = ৫৭৬ ডট। A4 হলে ব্লুটুথে ৫৮mm ধরা হয়। */
(function(){
  "use strict";
  const FONT = "'Noto Sans Bengali','Hind Siliguri','Noto Sans',sans-serif";

  function paperOf(opts){
    let p = opts && opts.paper ? String(opts.paper) : "";
    if(!p){ try{ p = localStorage.getItem("hb-paper") || ""; }catch(e){} }
    return p === "80" ? "80" : "58";
  }
  function dotsOf(p){ return p === "80" ? 576 : 384; }

  // রঙিন ইমোজি থার্মাল কাগজে কালো দাগ হয়ে যায় — তাই ছাপার আগে বাদ
  function clean(s){
    return String(s == null ? "" : s)
      .replace(/[\p{Extended_Pictographic}‍️⃣]/gu, "")
      .replace(/[ \t ]+/g, " ")
      .trim();
  }

  /* ── রসিদের HTML থেকে লাইনের তালিকা ──
     {t, b, c, size}  লেখা   ·   {l, r, b}  বাঁয়ে নাম, ডানে টাকা   ·   {sep:1}  দাগ */
  function cs(el){ return window.getComputedStyle(el); }
  function isBlock(el){
    if(el.nodeType !== 1) return false;
    if(el.tagName === "BR") return false;
    const d = cs(el).display;
    return !(d === "inline" || d === "inline-block" || d === "contents");
  }
  function hidden(el){ return el.nodeType === 1 && cs(el).display === "none"; }
  function textOf(node){
    if(node.nodeType === 3) return node.nodeValue;
    if(node.nodeType !== 1) return "";
    if(node.tagName === "BR") return "\n";
    if(/^(SCRIPT|STYLE|svg|SVG|IMG|CANVAS)$/.test(node.tagName) || hidden(node)) return "";
    let s = ""; node.childNodes.forEach(n=>{ s += textOf(n); });
    if(isBlock(node)) s = "\n" + s + "\n";
    return s;
  }
  function isBold(el){
    const w = parseInt(cs(el).fontWeight, 10) || 400;
    if(w >= 700) return true;
    const b = el.querySelector && el.querySelector("b,strong");
    return !!(b && clean(b.textContent) && clean(b.textContent) === clean(el.textContent));
  }
  function sizeOf(el){ return parseFloat(cs(el).fontSize) || 12; }
  function hasRule(el, side){
    const s = cs(el);
    const w = parseFloat(s["border" + side + "Width"]) || 0;
    const st = s["border" + side + "Style"];
    return w > 0 && st && st !== "none" && st !== "hidden";
  }
  function pushText(out, raw, el){
    const center = cs(el).textAlign === "center";
    const bold = isBold(el), size = sizeOf(el);
    String(raw).split("\n").map(clean).filter(Boolean).forEach(t=> out.push({ t, b:bold, c:center, size }));
  }
  function walk(el, out){
    if(el.nodeType !== 1 || hidden(el)) return;
    const tag = el.tagName;
    if(/^(SCRIPT|STYLE|svg|SVG|IMG|CANVAS)$/.test(tag)) return;
    if(tag === "HR"){ out.push({ sep:1 }); return; }
    if(tag === "TR"){
      const cells = Array.from(el.cells).filter(c=> !hidden(c));
      if(cells.length >= 2){
        const l = clean(textOf(cells[0]).replace(/\n+/g, " ")), r = clean(textOf(cells[cells.length - 1]).replace(/\n+/g, " "));
        if(l || r) out.push({ l, r, b:isBold(el) || isBold(cells[0]) });
      } else if(cells[0]){ pushText(out, textOf(cells[0]), cells[0]); }
      return;
    }
    const topRule = hasRule(el, "Top"), botRule = hasRule(el, "Bottom");
    const boxed = topRule && botRule && hasRule(el, "Left");
    if(topRule && !boxed) out.push({ sep:1 });
    if(boxed) out.push({ sep:2 });
    const kids = Array.from(el.children).filter(k=> !hidden(k));
    const d = cs(el).display;
    if(d.indexOf("flex") > -1 && kids.length === 2 && !kids.some(k=> Array.from(k.children).some(isBlock))){
      out.push({ l:clean(textOf(kids[0]).replace(/\n+/g, " ")), r:clean(textOf(kids[1]).replace(/\n+/g, " ")), b:isBold(el) || isBold(kids[0]) });
    } else if(/^(TABLE|TBODY|THEAD|TFOOT)$/.test(tag)){
      kids.forEach(k=> walk(k, out));
    } else if(!kids.some(isBlock)){
      pushText(out, textOf(el), el);
    } else {
      let run = "";
      const flush = ()=>{ if(clean(run)) pushText(out, run, el); run = ""; };
      el.childNodes.forEach(n=>{
        if(n.nodeType === 1 && isBlock(n)){ flush(); walk(n, out); }
        else run += textOf(n);
      });
      flush();
    }
    if(boxed) out.push({ sep:2 });
    else if(botRule && !(kids.length === 0)) out.push({ sep:3 });
  }
  function linesOf(el){
    const out = []; walk(el, out);
    // পাশাপাশি দুটো দাগ হলে একটাই রাখা
    return out.filter((x, i)=> !(x.sep && out[i - 1] && out[i - 1].sep && x.sep === out[i - 1].sep));
  }

  /* ── লাইনগুলো ছবিতে আঁকা ── */
  function render(lines, dots){
    const W = dots, M = 10, U = W - M * 2;
    const base = dots >= 576 ? 24 : 22;
    const mc = document.createElement("canvas").getContext("2d");
    const fontFor = (x)=>{
      let px = base;
      if(x.size >= 26) px = Math.round(base * 2);        // বড় অর্ডার নম্বর
      else if(x.size >= 15.5) px = Math.round(base * 1.18);
      return (x.b ? "800 " : "") + px + "px " + FONT;
    };
    function wrap(text, font, maxW){
      mc.font = font;
      const words = String(text).split(" "), out = [];
      let cur = "";
      words.forEach(w=>{
        const test = cur ? cur + " " + w : w;
        if(mc.measureText(test).width <= maxW){ cur = test; return; }
        if(cur) out.push(cur);
        if(mc.measureText(w).width <= maxW){ cur = w; return; }
        let chunk = "";
        for(const ch of w){ if(mc.measureText(chunk + ch).width > maxW && chunk){ out.push(chunk); chunk = ch; } else chunk += ch; }
        cur = chunk;
      });
      if(cur) out.push(cur);
      return out.length ? out : [""];
    }
    const ops = []; let y = 8;
    lines.forEach(x=>{
      if(x.sep){ ops.push({ k:"sep", y:y + 7, heavy:x.sep === 2 }); y += 14; return; }
      if(x.l != null){
        const f = fontFor({ size:12, b:x.b }); mc.font = f;
        const px = parseInt(f.replace(/^800 /, ""), 10), lh = Math.round(px * 1.32);
        const rw = x.r ? mc.measureText(x.r).width : 0;
        const left = wrap(x.l, f, Math.max(60, U - rw - 12));
        left.forEach((t, i)=>{ ops.push({ k:"t", f, t, x:M, y:y + px, a:"left" }); if(i === 0 && x.r) ops.push({ k:"t", f, t:x.r, x:W - M, y:y + px, a:"right" }); y += lh; });
        return;
      }
      const f = fontFor(x); const px = parseInt(f.replace(/^800 /, ""), 10), lh = Math.round(px * 1.32);
      wrap(x.t, f, U).forEach(t=>{ ops.push({ k:"t", f, t, x:x.c ? W / 2 : M, y:y + px, a:x.c ? "center" : "left" }); y += lh; });
    });
    y += 10;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = Math.max(40, Math.ceil(y));
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, cv.height);
    ctx.fillStyle = "#000"; ctx.strokeStyle = "#000"; ctx.textBaseline = "alphabetic";
    ops.forEach(o=>{
      if(o.k === "sep"){
        ctx.lineWidth = o.heavy ? 3 : 2; ctx.setLineDash(o.heavy ? [] : [6, 4]);
        ctx.beginPath(); ctx.moveTo(M, o.y); ctx.lineTo(W - M, o.y); ctx.stroke(); ctx.setLineDash([]);
        return;
      }
      ctx.font = o.f; ctx.textAlign = o.a; ctx.fillText(o.t, o.x, o.y);
    });
    return cv;
  }

  /* ── ছবি → ESC/POS (POS-এর btCanvasToEscposRaster-এর মতোই) ── */
  function raster(canvas){
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, bpr = Math.ceil(w / 8);
    const data = ctx.getImageData(0, 0, w, h).data;
    const r = new Uint8Array(bpr * h);
    for(let yy = 0; yy < h; yy++) for(let xx = 0; xx < w; xx++){
      const i = (yy * w + xx) * 4;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if(data[i + 3] > 10 && lum < 160) r[yy * bpr + (xx >> 3)] |= (1 << (7 - (xx % 8)));
    }
    const head = [0x1B, 0x40, 0x1D, 0x76, 0x30, 0x00, bpr & 255, (bpr >> 8) & 255, h & 255, (h >> 8) & 255];
    const out = new Uint8Array(head.length + r.length + 4);
    out.set(head, 0); out.set(r, head.length); out.set([10, 10, 10, 10], head.length + r.length);
    return out;
  }
  function b64(bytes){ let s = ""; for(let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

  async function loadFonts(){
    try{
      if(document.fonts && document.fonts.load){
        await Promise.race([
          Promise.all([document.fonts.load("22px 'Noto Sans Bengali'"), document.fonts.load("800 22px 'Noto Sans Bengali'")]),
          new Promise(r=> setTimeout(r, 1200))
        ]);
      }
    }catch(e){}
  }


  /* ── প্রিন্টার লাগানোর গাইড (বাংলা, ধাপে ধাপে) — সব অ্যাপে একই লেখা ── */
  function guideHtml(){
    return '<details class="hbPrGuide" style="margin-top:10px; border:1px solid rgba(128,128,128,.35); border-radius:12px; padding:10px 12px; font-size:13px; line-height:1.6;">'
      + '<summary style="cursor:pointer; font-weight:700;">📖 প্রিন্টার লাগানোর নিয়ম (প্রথমবার পড়ে নিন)</summary>'
      + '<div style="margin-top:8px"><b>📱 মোবাইল — ব্লুটুথ প্রিন্টার (Android)</b><ol style="margin:4px 0 8px 18px; padding:0">'
      + '<li>Play Store থেকে <b>"RawBT: inkless print service"</b> অ্যাপ ইন্সটল করুন।</li>'
      + '<li>ফোনের Bluetooth চালু করে প্রিন্টারটা জোড়া (pair) লাগান। পিন চাইলে সাধারণত <b>0000</b> বা <b>1234</b>।</li>'
      + '<li>RawBT খুলে Settings → Connection method: <b>Bluetooth</b> → আপনার প্রিন্টারটা বেছে নিন।</li>'
      + '<li>RawBT-তে আর এখানে <b>একই কাগজের মাপ</b> (৫৮ বা ৮০ mm) বাছুন।</li>'
      + '<li>"🔵 ব্লুটুথ" বোতাম চাপুন। প্রথমবার Chrome জিজ্ঞেস করলে <b>RawBT</b> → <b>"সবসময়"</b> বাছুন।</li></ol>'
      + '<b>💻 কম্পিউটার — Windows (USB বা নেটওয়ার্ক/IP)</b><ol style="margin:4px 0 8px 18px; padding:0">'
      + '<li><b>USB:</b> প্রিন্টারের সাথে আসা ড্রাইভার ইন্সটল করুন, তারপর USB লাগান।</li>'
      + '<li><b>IP/LAN:</b> প্রিন্টার বন্ধ অবস্থায় Feed বোতাম চেপে ধরে চালু করুন — একটা পরীক্ষার পাতায় IP ঠিকানা ছাপা হবে।</li>'
      + '<li>Windows Settings → Printers &amp; scanners → Add device → <b>Add manually</b> (Windows 10-এ "The printer that I want isn\'t listed") → <b>Add a printer using an IP address</b> → IP লিখুন → ড্রাইভার বাছুন।</li>'
      + '<li>ছাপার উইন্ডোতে প্রিন্টারটা বেছে Margins: <b>None</b>, Scale: <b>100</b>, "Headers and footers" <b>বন্ধ</b> রাখুন।</li></ol>'
      + '<span style="opacity:.8">বাংলা অক্ষর ভাঙে না, কারণ রসিদ ছবি হিসেবে পাঠানো হয়। সমস্যা হলে আগে "পরীক্ষা" প্রিন্ট দিয়ে দেখুন।</span></div></details>';
  }

  /* প্রথমবার ব্লুটুথ প্রিন্টের আগে একবার গাইড দেখানো — "প্রিন্ট করুন" চাপলে
     তখনই পাঠানো হয় (বোতাম চাপাটাই Chrome-এর অনুমতি, তাই RawBT খুলতে বাধা নেই) */
  function firstTime(go){
    let seen = false; try{ seen = localStorage.getItem("hb-bt-seen") === "1"; }catch(e){}
    if(seen){ go(); return; }
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed; inset:0; z-index:100001; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; padding:16px;";
    ov.innerHTML = '<div style="background:#fff; color:#111; max-width:440px; width:100%; max-height:86vh; overflow:auto; border-radius:16px; padding:16px; font-family:inherit;">'
      + '<div style="font-weight:800; font-size:16px; margin-bottom:4px">🔵 ব্লুটুথ প্রিন্ট — প্রথমবার</div>'
      + '<div style="font-size:13px">ফোনে RawBT অ্যাপ আর প্রিন্টার জোড়া লাগানো থাকলে সরাসরি প্রিন্ট করুন। না থাকলে নিচের নিয়মটা দেখুন।</div>'
      + guideHtml().replace('<details ', '<details open ')
      + '<div style="display:flex; gap:8px; margin-top:12px"><button type="button" data-x style="flex:1; padding:11px; border-radius:10px; border:1px solid #ccc; background:#fff; font-family:inherit">বাতিল</button>'
      + '<button type="button" data-go style="flex:2; padding:11px; border-radius:10px; border:0; background:#16A34A; color:#fff; font-weight:800; font-family:inherit">🖨️ প্রিন্ট করুন</button></div></div>';
    ov.addEventListener("click", (e)=>{
      if(e.target === ov || e.target.closest("[data-x]")){ ov.remove(); return; }
      if(e.target.closest("[data-go]")){ try{ localStorage.setItem("hb-bt-seen", "1"); }catch(err){} ov.remove(); go(); }
    });
    document.body.appendChild(ov);
  }

  function send(bytes){
    location.href = "intent:base64," + b64(bytes) + "#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;";
  }
  function fail(e){
    console.error("HBBT print failed:", e);
    alert("ব্লুটুথ প্রিন্টে পাঠাতে সমস্যা হয়েছে।\n\nচেক করুন: ফোনে \"RawBT: inkless print service\" অ্যাপ ইন্সটল আছে কি না, আর RawBT-তে প্রিন্টারটা বেছে রাখা আছে কি না।");
  }

  async function canvasFor(el, opts){
    await loadFonts();
    return render(linesOf(el), dotsOf(paperOf(opts)));
  }
  // পাতার রসিদ-অংশটা প্রায়ই display:none থাকে (শুধু ছাপার সময় দেখা যায়) —
  // তাই তার একটা কপি পর্দার বাইরে বসিয়ে সেখান থেকে লাইন পড়া হয়
  async function printElement(el, opts){
    if(!el){ return; }
    return printHtml(el.innerHTML, opts);
  }
  function printHtml(html, opts){
    return new Promise(res=> firstTime(()=> res(doPrintHtml(html, opts))));
  }
  async function doPrintHtml(html, opts){
    const box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.style.cssText = "position:fixed; left:-10000px; top:0; width:280px; font-family:monospace; font-size:12px; color:#000; background:#fff;";
    box.innerHTML = html;
    document.body.appendChild(box);
    try{ send(raster(await canvasFor(box, opts))); }catch(e){ fail(e); }
    finally{ setTimeout(()=> box.remove(), 50); }
  }
  // পরীক্ষার জন্য (প্রিন্টারে না পাঠিয়ে ছবিটা দেখা)
  async function previewHtml(html, opts){
    const box = document.createElement("div");
    box.style.cssText = "position:fixed; left:-10000px; top:0; width:280px; font-family:monospace; font-size:12px;";
    box.innerHTML = html; document.body.appendChild(box);
    try{ return await canvasFor(box, opts); } finally{ box.remove(); }
  }

  window.HBBT = { printElement, printHtml, previewHtml, canvasFor, linesOf, paperOf, guideHtml };
})();
