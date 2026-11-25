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

  var P = C.Plugins && C.Plugins.PushNotifications;
  if (!P) { console.warn("[hb-native-push] PushNotifications প্লাগিন পাওয়া যায়নি"); return; }

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
  function patch() {
    var fb = window.firebase;
    if (!fb || typeof fb.messaging !== "function") return false;
    if (fb.__hbNativePatched) return true;
    var fn = function () { return shim; };
    fn.isSupported = function () { return true; };
    try { fb.messaging = fn; } catch (e) { try { Object.defineProperty(fb, "messaging", { value: fn, configurable: true }); } catch (e2) { return false; } }
    fb.__hbNativePatched = true;
    return true;
  }
  if (!patch()) {
    var tries = 0, iv = setInterval(function () { if (patch() || ++tries > 200) clearInterval(iv); }, 50);
  }
})();
