/* =====================================================================
   🔙 hb-back.js — ফোনের Back বোতামে অ্যাপ বন্ধ হবে না
   ---------------------------------------------------------------------
   আগে মূল পাতায় Back চাপলে অ্যাপ বন্ধ হয়ে যেত; আবার খুললে শুরু থেকে
   "যাচাই করা হচ্ছে…" — দেখতে লগআউটের মতো। এখন Back চাপলে অ্যাপ এখানেই
   থাকে আর ছোট লেখা দেখায়: বের হতে Home চাপুন (অ্যাপ পেছনে চালু থাকে,
   Recents থেকে টেনে সরালে তবেই বন্ধ)।
   পাতা নিজে কিছু বন্ধ করতে চাইলে (খোলা পপ-আপ, অন্য পাতা থেকে হোমে):
     window.hbBackHook = () => { …; return true; }   // true = সামলানো হয়েছে
   ===================================================================== */
(function(){
  if(window.__hbBackGuard) return; window.__hbBackGuard = true;
  const push = ()=>{ try{ history.pushState({ hbBackGuard: Date.now() }, "", location.href); }catch(e){} };
  let last = 0;
  function note(){
    const now = Date.now(); if(now - last < 1500) return; last = now;
    let d = document.getElementById("hbBackToast");
    if(!d){
      d = document.createElement("div"); d.id = "hbBackToast";
      d.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(20,14,4,.92);color:#ffd166;padding:11px 16px;border-radius:12px;font:600 13.5px 'Noto Sans Bengali',system-ui,sans-serif;z-index:2147483646;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:88vw;text-align:center;transition:opacity .3s;pointer-events:none;";
      document.body.appendChild(d);
    }
    d.textContent = "🐝 বের হতে ফোনের Home বোতাম চাপুন — অ্যাপ পেছনে চালু থাকবে";
    d.style.opacity = "1"; clearTimeout(d.__t); d.__t = setTimeout(()=>{ d.style.opacity = "0"; }, 2600);
  }
  window.hbBackNote = note;
  function start(){
    push(); push(); // দুইটা বাফার — দ্রুত দুবার চাপলেও তলানিতে পৌঁছায় না
    // Chrome ছোঁয়া ছাড়া বসানো পাহারা Back-এ এড়িয়ে যেতে পারে — প্রথম ছোঁয়ায় আরেকটা বসানো
    window.addEventListener("pointerdown", push, { once: true, capture: true });
    window.addEventListener("popstate", ()=>{
      push();
      try{ if(typeof window.hbBackHook === "function" && window.hbBackHook()) return; }catch(e){}
      note();
    });
  }
  if(document.readyState === "complete") start(); else window.addEventListener("load", start);
})();
