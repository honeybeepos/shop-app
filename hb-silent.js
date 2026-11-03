/* 🔕 Honey Bee — নিঃশব্দ বাটন (মসজিদ/মিটিংয়ে অ্যাপের আওয়াজ বন্ধ রাখতে)
   কেন দরকার: ফোনের কাঁপুনি/সাইলেন্ট মোড শুধু রিংটোন-নোটিফিকেশনের আওয়াজ বন্ধ করে। অ্যাপের ভেতরের বিপ চলে
   "Media" ভলিউমে, তাই ফোন সাইলেন্টে থাকলেও বাজে — আর ওয়েব পেজ ফোনের সাইলেন্ট মোড দেখতেও পায় না।
   এই ফাইল সব অ্যাপে (ড্রাইভার, ডেলিভারি, POS, রেস্টুরেন্ট, ফার্মেসি, টেইলর) একই বাটন দেয়: 🔔 চাপলে
   "৩০ মিনিট / ১ ঘণ্টা / চালু না করা পর্যন্ত" নিঃশব্দ। নিঃশব্দে শুধু কাঁপুনি হয়; সময় শেষে নিজে থেকে আবার চালু।
   সব অ্যাপে একই সেটিং চলে (localStorage hbSilentUntil)। কোড বদলানো লাগে না: AudioNode.connect-এ আটকে দেওয়া হয়। */
(function(){
  "use strict";
  var KEY = "hbSilentUntil"; // মিলিসেকেন্ড (শেষ সময়); -1 = চালু না করা পর্যন্ত; ০/নেই = আওয়াজ চালু
  function read(){ try{ var v = Number(localStorage.getItem(KEY) || 0); return isFinite(v) ? v : 0; }catch(e){ return 0; } }
  function isSilent(){
    var v = read();
    if(v === -1) return true;
    if(v > Date.now()) return true;
    if(v > 0){ try{ localStorage.removeItem(KEY); }catch(e){} }
    return false;
  }
  function leftText(){
    var v = read();
    if(v === -1) return "চালু না করা পর্যন্ত";
    var m = Math.ceil((v - Date.now()) / 60000);
    return m > 0 ? "আর " + m + " মিনিট" : "";
  }
  window.hbSilent = { isSilent: isSilent, set: function(min){
    try{
      if(!min) localStorage.removeItem(KEY);
      else if(min < 0) localStorage.setItem(KEY, "-1");
      else localStorage.setItem(KEY, String(Date.now() + min * 60000));
    }catch(e){}
    if(window.__hbSilentPaint) window.__hbSilentPaint();
  }};

  // 🔇 সব WebAudio আওয়াজ আটকানো — স্পিকারে (destination) জোড়া লাগানোর মুহূর্তে নিঃশব্দ থাকলে জোড়াই লাগে না
  try{
    var AN = window.AudioNode;
    if(AN && AN.prototype && !AN.prototype.__hbSilentPatched){
      var orig = AN.prototype.connect;
      AN.prototype.connect = function(dest){
        try{ if(window.AudioDestinationNode && dest instanceof window.AudioDestinationNode && isSilent()) return dest; }catch(e){}
        return orig.apply(this, arguments);
      };
      AN.prototype.__hbSilentPatched = true;
    }
  }catch(e){}

  if(typeof document === "undefined") return;
  var btn, menu;
  function paint(){
    if(!btn) return;
    var s = isSilent();
    btn.textContent = s ? "🔕" : "🔔";
    btn.style.background = s ? "#b91c1c" : "rgba(20,20,20,.78)";
    btn.setAttribute("aria-label", s ? "নিঃশব্দ চালু" : "আওয়াজ চালু");
    var st = menu && menu.querySelector("[data-st]");
    if(st) st.textContent = s ? "🔕 এখন নিঃশব্দ — " + leftText() : "🔔 আওয়াজ চালু আছে";
  }
  window.__hbSilentPaint = paint;
  function build(){
    if(btn || !document.body) return;
    btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText = "position:fixed;left:10px;bottom:96px;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.25);color:#fff;font-size:19px;line-height:1;z-index:2147483000;box-shadow:0 2px 10px rgba(0,0,0,.45);cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent";
    menu = document.createElement("div");
    menu.style.cssText = "position:fixed;left:10px;bottom:146px;z-index:2147483001;background:#1b1b1b;color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:8px;min-width:230px;display:none;box-shadow:0 6px 22px rgba(0,0,0,.6);font-family:inherit";
    var items = [["🔔 আওয়াজ চালু", 0], ["🕌 ৩০ মিনিট নিঃশব্দ", 30], ["🕌 ১ ঘণ্টা নিঃশব্দ", 60], ["🔕 চালু না করা পর্যন্ত নিঃশব্দ", -1]];
    menu.innerHTML = '<div data-st style="font-size:12.5px;font-weight:800;padding:4px 8px 6px;color:#fbbf24"></div>'
      + items.map(function(it){ return '<button type="button" data-m="' + it[1] + '" style="display:block;width:100%;text-align:left;background:transparent;color:#fff;border:0;border-radius:8px;padding:9px 8px;font-size:13.5px;cursor:pointer;font-family:inherit">' + it[0] + '</button>'; }).join("")
      + '<div style="font-size:11px;color:#a3a3a3;padding:4px 8px 2px">নিঃশব্দে শুধু কাঁপুনি হবে — নোটিফিকেশন ঠিকই আসবে।</div>';
    btn.addEventListener("click", function(e){ e.stopPropagation(); paint(); menu.style.display = menu.style.display === "block" ? "none" : "block"; });
    menu.addEventListener("click", function(e){
      e.stopPropagation();
      var b = e.target.closest("[data-m]"); if(!b) return;
      window.hbSilent.set(Number(b.getAttribute("data-m")));
      menu.style.display = "none";
    });
    document.addEventListener("click", function(){ if(menu) menu.style.display = "none"; });
    document.body.appendChild(btn); document.body.appendChild(menu);
    paint();
    setInterval(paint, 15000);
    window.addEventListener("storage", function(ev){ if(ev.key === KEY) paint(); });
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
