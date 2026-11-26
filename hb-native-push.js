/* =====================================================================
   📱 hb-native-push.js — Android অ্যাপের (Capacitor) নেটিভ পুশ
   ---------------------------------------------------------------------
   ব্রাউজারে/Chrome-এ এই ফাইল কিছুই করে না (প্রথম লাইনেই বেরিয়ে যায়)।
   শুধু Honey Bee Android অ্যাপের ভেতরে খুললে চলে, আর পাতার বাকি কোড
   না বদলিয়ে ওয়েব-পুশের জায়গায় নেটিভ FCM বসিয়ে দেয়:
     • Notification.permission / requestPermission()  → ফোনের নেটিভ অনুমতি
     • firebase.messaging().getToken()               → নেটিভ FCM টোকেন
     • firebase.messaging().onMessage()              → অ্যাপ খোলা অবস্থার পুশ
     • নোটিফিকেশনে ট্যাপ                              → data.link-এর পাতা খোলে
   টোকেন আগের মতোই Firestore-এ (fcmToken) সেভ হয়, সার্ভারের কোড একই থাকে।
   ===================================================================== */
(function () {
  var C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== "function" || !C.isNativePlatform()) return;
  if (window.__hbNativePush) return;
  window.__hbNativePush = true;

  /* 🔎 পর্দায় ছোট বার্তা (সমস্যা ধরার জন্য) */
  function hbToast(msg, ms) {
    try {
      var el = document.getElementById("hbNativeToast");
      if (!el) {
        el = document.createElement("div"); el.id = "hbNativeToast";
        el.style.cssText = "position:fixed;left:10px;right:10px;bottom:70px;z-index:2147483647;background:#000c;color:#fff;border:1px solid #ffd166;border-radius:10px;padding:10px 12px;font:13px/1.5 sans-serif;word-break:break-word;pointer-events:none";
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = msg; el.style.display = "block";
      clearTimeout(el.__t); el.__t = setTimeout(function () { el.style.display = "none"; }, ms || 4000);
    } catch (e) {}
  }
  var P = C.Plugins && C.Plugins.PushNotifications;
  try {
    var have = Object.keys(C.Plugins || {}).join(",");
    hbToast("📱 নেটিভ মোড চালু — প্লাগিন: " + (have || "নেই"), 5000);
  } catch (e) {}
  if (!P) { hbToast("⚠️ PushNotifications প্লাগিন পাওয়া যায়নি", 8000); return; }

  var perm = "default";
  function mapPerm(r) { return r === "granted" ? "granted" : (r === "denied" ? "denied" : "default"); }
  P.checkPermissions().then(function (r) { perm = mapPerm(r.receive); }).catch(function () {});

  /* ---- Notification (অনুমতি) ---- */
  function NotifShim() { /* অ্যাপ খোলা অবস্থার ছোট popup — পাতার নিজস্ব UI-ই দেখায়, এখানে কিছু না */ }
  Object.defineProperty(NotifShim, "permission", { get: function () { return perm; } });
  NotifShim.requestPermission = function (cb) {
    var p = P.requestPermissions().then(function (r) { perm = mapPerm(r.receive); return perm; }).catch(function () { return perm; });
    if (typeof cb === "function") p.then(cb);
    return p;
  };
  try { Object.defineProperty(window, "Notification", { value: NotifShim, configurable: true, writable: true }); }
  catch (e) { try { window.Notification = NotifShim; } catch (e2) {} }

  /* ---- Service Worker না থাকলে ফাঁকা বসানো (পাতার কোড register() ডাকে) ---- */
  if (!("serviceWorker" in navigator)) {
    try {
      Object.defineProperty(navigator, "serviceWorker", {
        value: { register: function () { return Promise.resolve({}); }, ready: Promise.resolve({}) }, configurable: true
      });
    } catch (e) {}
  }

  /* ---- নোটিফিকেশন চ্যানেল (হাই-ইম্পরট্যান্স — সার্ভারের channelId "hb_default") ---- */
  var channelDone = false;
  function ensureChannel() {
    if (channelDone) return Promise.resolve();
    channelDone = true;
    return P.createChannel({
      id: "hb_default", name: "Honey Bee নোটিফিকেশন", description: "অর্ডার, মেসেজ, ডেলিভারি",
      importance: 5, visibility: 1, vibration: true
    }).catch(function () {});
  }

  /* ---- টোকেন ---- */
  var cachedToken = null, pending = null;
  function nativeGetToken() {
    if (cachedToken) return Promise.resolve(cachedToken);
    if (pending) return pending;
    pending = (async function () {
      var r = await P.checkPermissions();
      if (r.receive !== "granted") r = await P.requestPermissions();
      perm = mapPerm(r.receive);
      if (perm !== "granted") throw new Error("notification-permission-denied");
      await ensureChannel();
      return await new Promise(function (resolve, reject) {
        var done = false, h1, h2;
        var t = setTimeout(function () { fin(new Error("fcm-register-timeout")); }, 20000);
        function fin(err, tok) {
          if (done) return; done = true; clearTimeout(t);
          try { h1 && h1.remove && h1.remove(); h2 && h2.remove && h2.remove(); } catch (e) {}
          err ? reject(err) : resolve(tok);
        }
        Promise.resolve(P.addListener("registration", function (ev) { fin(null, ev.value); })).then(function (h) { h1 = h; });
        Promise.resolve(P.addListener("registrationError", function (ev) { fin(new Error((ev && ev.error) || "fcm-register-error")); })).then(function (h) { h2 = h; });
        P.register();
      });
    })().then(function (tok) { cachedToken = tok; pending = null; return tok; },
              function (e) { pending = null; throw e; });
    return pending;
  }

  /* ---- অ্যাপ খোলা অবস্থার পুশ + ট্যাপ ---- */
  var listeners = [];
  P.addListener("pushNotificationReceived", function (n) {
    var payload = { data: n.data || {}, notification: { title: n.title || "", body: n.body || "" } };
    listeners.slice().forEach(function (fn) { try { fn(payload); } catch (e) {} });
  });
  P.addListener("pushNotificationActionPerformed", function (a) {
    var d = (a && a.notification && a.notification.data) || {};
    var link = d.link;
    if (!link) return;
    try {
      var u = new URL(link, location.href);
      if (u.hostname === location.hostname && u.href !== location.href) location.href = u.href;
    } catch (e) {}
  });

  /* ---- firebase.messaging() বদলানো ---- */
  var shim = {
    getToken: function () { return nativeGetToken(); },
    deleteToken: function () { cachedToken = null; return Promise.resolve(P.unregister()).then(function () { return true; }, function () { return true; }); },
    onMessage: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
    onBackgroundMessage: function () { return function () {}; },
    requestPermission: function () { return NotifShim.requestPermission(); }
  };
  /* ---- Google লগইন: ওয়েব-ভিউয়ে popup/redirect চলে না (Google 400 দেয়) —
          তাই অ্যাপের ভেতরে নেটিভ Google লগইন চালিয়ে সেই টোকেন Firebase-এ দেওয়া হয়।
          পাতার কোড একই থাকে: auth.signInWithPopup(googleProvider) ডাকলেই এটা চলে। ---- */
  function nativeGoogleSignIn(authSelf) {
    var A = C.Plugins && C.Plugins.FirebaseAuthentication;
    hbToast("🔵 Google লগইন শুরু হচ্ছে…", 3000);
    if (!A) hbToast("⚠️ Google লগইনের প্লাগিন অ্যাপে নেই — নতুন APK বানাতে হবে", 9000);
    if (!A) return Promise.reject(Object.assign(new Error("native-auth-plugin-missing"), { code: "auth/operation-not-supported-in-this-environment" }));
    /* নতুন Credential Manager-এ "No credentials available" এলে পুরনো Google সাইন-ইন পদ্ধতিতে আবার চেষ্টা */
    return A.signInWithGoogle({ skipNativeAuth: true }).catch(function (e) {
      if (/no credentials|NoCredential/i.test(String((e && (e.message || e.code)) || ""))) {
        hbToast("🔁 অন্য পদ্ধতিতে চেষ্টা হচ্ছে…", 3000);
        return A.signInWithGoogle({ skipNativeAuth: true, useCredentialManager: false });
      }
      throw e;
    }).then(function (res) {
      var c = res && res.credential;
      if (!c || !c.idToken) throw Object.assign(new Error("no-id-token"), { code: "auth/internal-error" });
      var cred = window.firebase.auth.GoogleAuthProvider.credential(c.idToken, c.accessToken || null);
      return authSelf.signInWithCredential(cred);
    }).catch(function (e) {
      var msg = String((e && (e.message || e.code)) || "");
      if (/cancel/i.test(msg) || /12501|\b16\b/.test(msg)) e = Object.assign(new Error("cancelled"), { code: "auth/popup-closed-by-user" });
      else hbToast("❌ Google লগইন ব্যর্থ: " + msg.slice(0, 220), 12000);
      throw e;
    });
  }
  function patchAuth() {
    var fb = window.firebase;
    if (!fb || !fb.auth || !fb.auth.Auth || !fb.auth.Auth.prototype || !fb.auth.GoogleAuthProvider) return false;
    if (fb.__hbAuthPatched) return true;
    var proto = fb.auth.Auth.prototype;
    ["signInWithPopup", "signInWithRedirect"].forEach(function (name) {
      var orig = proto[name];
      proto[name] = function (provider) {
        if (provider && provider.providerId === "google.com") {
          var self = this;
          return nativeGoogleSignIn(self).then(function (r) { return name === "signInWithRedirect" ? undefined : r; });
        }
        return orig.apply(this, arguments);
      };
    });
    fb.__hbAuthPatched = true;
    return true;
  }

  function patch() {
    var fb = window.firebase;
    var a = patchAuth();
    var m = false;
    if (fb && typeof fb.messaging === "function") {
      if (fb.__hbNativePatched) m = true;
      else {
        var fn = function () { return shim; };
        fn.isSupported = function () { return true; };
        try { fb.messaging = fn; m = true; }
        catch (e) { try { Object.defineProperty(fb, "messaging", { value: fn, configurable: true }); m = true; } catch (e2) {} }
        if (m) fb.__hbNativePatched = true;
      }
    }
    return a && m;
  }
  if (!patch()) {
    var tries = 0, iv = setInterval(function () { if (patch() || ++tries > 200) clearInterval(iv); }, 50);
  }
})();
