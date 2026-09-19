/* ============================================================
   zatca-ledger.js — 🇸🇦 কর চালানের খাতা (ZATCA invoice ledger)

   ── কেন এটা আলাদা একটা খাতা, অ্যাপের সাধারণ হিসাবের সাথে নয় ──

   অ্যাপের বাকি সব ডেটা ক্লাউডে যায় একটা বড় "ব্লব" হিসেবে — পুরো
   localStorage একসাথে তুলে দেওয়া হয়, আর নামানোর সময় localStorage মুছে
   নতুন করে বসানো হয়। সাধারণ হিসাবের জন্য এটা চলে। কিন্তু কর চালানের
   খাতার জন্য এটা বিপজ্জনক, তিনটা কারণে:

   ১) দুই ফোন থেকে একই সময়ে বিক্রি হলে একজনের ব্লব আরেকজনেরটা চাপা দিয়ে
      দেয় — একটা চালান খাতা থেকে হারিয়ে যেতে পারে। সাধারণ হিসাবে সেটা
      বিরক্তিকর; কর খাতায় সেটা আইনি সমস্যা।
   ২) ক্লাউড থেকে নামানোর সময় localStorage পুরো মুছে ফেলা হয়।
   ৩) চালানের ক্রমিক নম্বর (ICV) পুরনো ব্লব দিয়ে পিছিয়ে গেলে একই নম্বর
      দুইবার ব্যবহার হয়ে যেত। ZATCA পরিষ্কার লিখেছে — একটা ICV একবারের
      বেশি ব্যবহার করা যাবে না।

   তাই এই খাতাটা ব্লবে যায় না। প্রতিটা চালান ক্লাউডে নিজের আলাদা
   ডকুমেন্ট হিসেবে জমা হয় — আলাদা ডকুমেন্ট কখনো একে অপরকে চাপা দেয় না।

   ── ক্রমিক নম্বর প্রতি ডিভাইসে আলাদা কেন ──

   ZATCA-র নিয়মে প্রতিটা "EGS unit" (যে যন্ত্রটা চালান বানায়) নিজের
   আলাদা ধারাবাহিক ক্রম রাখে, আর প্রতিটা EGS unit-এর নিজের সার্টিফিকেট
   থাকে। শাখার স্মার্ট POS যন্ত্র নিজেই একটা EGS unit। তাই প্রতিটা ফোন
   নিজের ক্রম রাখে — এতে ইন্টারনেট ছাড়াই নম্বর দেওয়া যায়, আর দুই ফোনের
   নম্বর কখনো ঠোকাঠুকি খায় না।

   ── যা এখানে নেই, আর কেন ──

   দ্বিতীয় ধাপের ঘরগুলো (চালানের হ্যাশ, আগের চালানের হ্যাশ, সই, XML)
   রাখা আছে কিন্তু **খালি**। ওগুলোর আসল মান আসে সই করা XML থেকে, যেটা
   এখনো বানানো হয়নি। খালি ঘর রাখা নিরাপদ; বানানো মান বসানো বিপজ্জনক —
   পরে কেউ ওটাকে আসল ভেবে বসতে পারে।
   ============================================================ */
(function (root) {
  "use strict";

  /* এই তিনটা কি ক্লাউডের ব্লবে যায় না, আর ব্লব নামানোর সময় মুছেও যায় না —
     firebase-init.js এদের আলাদা করে রক্ষা করে। নাম বদলালে ওখানেও বদলাতে হবে। */
  var K_EGS    = "zatca-egs-unit";
  var K_ICV    = "zatca-icv";
  var K_LEDGER = "zatca-ledger";
  var MAX_LOCAL = 2000;          // স্থানীয়ভাবে সর্বশেষ এতগুলো রাখা হয় (ক্লাউডে সব থাকে)

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.error("ZATCA ledger লিখতে পারেনি:", e); return false; }
  }

  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    var b;
    if (root.crypto && root.crypto.getRandomValues) {
      b = new Uint8Array(16); root.crypto.getRandomValues(b);
    } else {
      b = new Uint8Array(16);
      for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40;      // version 4
    b[8] = (b[8] & 0x3f) | 0x80;      // variant
    var h = [];
    for (var j = 0; j < 16; j++) h.push(("0" + b[j].toString(16)).slice(-2));
    return h.slice(0,4).join("") + "-" + h.slice(4,6).join("") + "-" + h.slice(6,8).join("") +
           "-" + h.slice(8,10).join("") + "-" + h.slice(10,16).join("");
  }

  /* এই ফোনের নিজস্ব EGS unit পরিচয় — একবার তৈরি হয়, আর কখনো বদলায় না।
     পরে ZATCA থেকে এই ইউনিটের সার্টিফিকেট নেওয়া হলে সেটা এই পরিচয়ের
     সাথেই বাঁধা থাকবে। */
  function egsUnitId() {
    var id = localStorage.getItem(K_EGS);
    if (!id) {
      id = "EGS-" + uuid();
      localStorage.setItem(K_EGS, id);
    }
    return id;
  }

  /* চালানের ক্রমিক নম্বর। ZATCA: ১ থেকে শুরু, কখনো রিসেট নয়, একই নম্বর
     দ্বিতীয়বার নয়। তাই নম্বরটা আগে বাড়িয়ে জমা করা হয়, তারপর ফেরত দেওয়া
     হয় — মাঝখানে অ্যাপ বন্ধ হয়ে গেলে ওই নম্বরটা খালি যাবে, কিন্তু কখনো
     দুইবার ব্যবহার হবে না। খালি যাওয়া নিরাপদ, পুনরাবৃত্তি নয়। */
  function nextIcv() {
    var cur = parseInt(localStorage.getItem(K_ICV) || "0", 10);
    if (!isFinite(cur) || cur < 0) cur = 0;
    var next = cur + 1;
    localStorage.setItem(K_ICV, String(next));
    return next;
  }
  function currentIcv() {
    var cur = parseInt(localStorage.getItem(K_ICV) || "0", 10);
    return isFinite(cur) ? cur : 0;
  }

  function allRecords() {
    var list = readJson(K_LEDGER, []);
    return Array.isArray(list) ? list : [];
  }

  /* একটা চালান খাতায় তোলা। এটা কেবল লিখেই যায় — কোনো রেকর্ড বদলানো বা
     মোছার উপায় রাখা হয়নি, কারণ কর চালানের খাতা বদলানো যায় না। ভুল হলে
     পরে ক্রেডিট নোট দিতে হয়, পুরনো চালান মুছে নয়। */
  function recordInvoice(inv) {
    inv = inv || {};
    var now = new Date();
    var issued = inv.issuedAt ? new Date(inv.issuedAt) : now;
    if (isNaN(issued.getTime())) issued = now;

    var rec = {
      id: uuid(),
      uuid: uuid(),                                  // ZATCA-র চালান UUID
      icv: nextIcv(),                                // ক্রমিক নম্বর
      egsUnitId: egsUnitId(),

      invoiceType: inv.invoiceType || "simplified",  // simplified = B2C, standard = B2B
      invoiceNumber: inv.invoiceNumber || "",        // POS-এর নিজের নম্বর (INV-000125)

      issueTimestamp: issued.toISOString().replace(/\.\d{3}Z$/, "Z"),
      issueDate: issued.toISOString().slice(0, 10),
      issueTime: issued.toISOString().slice(11, 19),

      seller: {
        legalName: inv.sellerName || "",
        vatNumber: inv.vatNumber || "",
        address: inv.sellerAddress || null
      },
      buyer: inv.buyer || null,                      // B2C-তে সাধারণত থাকে না

      currency: "SAR",                               // সৌদি কর চালান রিয়ালেই হয়
      vatRate: (inv.vatRate == null) ? 15 : Number(inv.vatRate),
      netAmount: Number(inv.netAmount) || 0,
      vatAmount: Number(inv.vatAmount) || 0,
      totalAmount: Number(inv.totalAmount) || 0,

      qrPhase1: inv.qr || "",                        // যে QR রসিদে ছাপা হয়েছে

      /* ---- দ্বিতীয় ধাপের ঘর — এখনো খালি, ইচ্ছে করেই ----
         এগুলোর আসল মান সই করা XML থেকে আসে। বানানো মান বসানো হয়নি। */
      phase2: {
        status: "not_started",   // not_started → queued → submitted → accepted/rejected
        invoiceHash: null,       // এই চালানের XML-এর হ্যাশ
        previousInvoiceHash: null, // আগের চালানের হ্যাশ (শেকল)
        signature: null,
        xmlRef: null,
        reportingStatus: null,   // সরলীকৃত চালানের জন্য
        clearanceStatus: null,   // B2B চালানের জন্য
        submittedAt: null,
        retryCount: 0,
        lastErrorCode: null,
        lastErrorMessage: null
      },

      cloudSynced: false,        // এই রেকর্ড ক্লাউডে পৌঁছেছে কিনা
      createdAt: now.toISOString(),
      deviceNote: inv.deviceNote || null
    };

    var list = allRecords();
    list.push(rec);
    if (list.length > MAX_LOCAL) list = list.slice(list.length - MAX_LOCAL);
    writeJson(K_LEDGER, list);
    return rec;
  }

  function pendingSync() {
    return allRecords().filter(function (r) { return !r.cloudSynced; });
  }

  function markSynced(ids) {
    var set = {};
    (Array.isArray(ids) ? ids : [ids]).forEach(function (i) { set[i] = true; });
    var list = allRecords();
    var changed = false;
    list.forEach(function (r) { if (set[r.id] && !r.cloudSynced) { r.cloudSynced = true; changed = true; } });
    if (changed) writeJson(K_LEDGER, list);
    return changed;
  }

  function stats() {
    var list = allRecords();
    var last = list.length ? list[list.length - 1] : null;
    return {
      egsUnitId: localStorage.getItem(K_EGS) || null,
      counter: currentIcv(),
      localCount: list.length,
      pendingSync: list.filter(function (r) { return !r.cloudSynced; }).length,
      lastInvoice: last ? {
        icv: last.icv, invoiceNumber: last.invoiceNumber,
        total: last.totalAmount, at: last.issueTimestamp
      } : null
    };
  }

  /* ক্রম ঠিক আছে কিনা দেখা — নম্বর পিছিয়ে যাওয়া বা একই নম্বর দুইবার থাকা
     মানে কোথাও গুরুতর গণ্ডগোল। কর খাতায় সেটা চুপচাপ রাখা যায় না। */
  function auditSequence() {
    var list = allRecords();
    var problems = [], seen = {}, prev = 0;
    list.forEach(function (r) {
      if (seen[r.icv]) problems.push("ক্রমিক নম্বর " + r.icv + " একাধিকবার ব্যবহার হয়েছে");
      seen[r.icv] = true;
      if (r.icv <= prev) problems.push("ক্রমিক নম্বর পিছিয়ে গেছে: " + prev + " → " + r.icv);
      prev = r.icv;
    });
    return { ok: problems.length === 0, problems: problems, checked: list.length };
  }

  root.ZatcaLedger = {
    KEYS: [K_EGS, K_ICV, K_LEDGER],
    egsUnitId: egsUnitId,
    nextIcv: nextIcv,
    currentIcv: currentIcv,
    record: recordInvoice,
    all: allRecords,
    pendingSync: pendingSync,
    markSynced: markSynced,
    stats: stats,
    audit: auditSequence,
    uuid: uuid
  };
})(typeof window !== "undefined" ? window : globalThis);
