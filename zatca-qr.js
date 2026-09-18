/* ============================================================
   zatca-qr.js — 🇸🇦 ZATCA (ফাতুরা) QR কোড তৈরির অংশ

   সৌদি আরবে ২০২১ সালের ৪ ডিসেম্বর থেকে প্রতিটা "সরলীকৃত কর চালান"
   (Simplified Tax Invoice — সাধারণ দোকানের খুচরা বিক্রির রসিদ) এবং তার
   ডেবিট/ক্রেডিট নোটে ZATCA-এর নিয়ম অনুযায়ী একটা QR কোড ছাপানো বাধ্যতামূলক।

   QR-এ যা থাকে তা ইচ্ছেমতো লেখা যায় না। ZATCA "TLV" নামের একটা নির্দিষ্ট
   কাঠামো ঠিক করে দিয়েছে — প্রতিটা তথ্যের জন্য একটা নম্বর (Tag), তার
   দৈর্ঘ্য (Length), তারপর তথ্যটা (Value)। সব জোড়া পাশাপাশি বসিয়ে পুরোটাকে
   Base64 করে QR বানাতে হয়।

   প্রথম ধাপে (Generation Phase) পাঁচটা তথ্য লাগে:
     Tag 1 — বিক্রেতার নাম
     Tag 2 — বিক্রেতার VAT রেজিস্ট্রেশন নম্বর (১৫ অঙ্ক)
     Tag 3 — চালানের সময় (ISO 8601, UTC — yyyy-MM-ddTHH:mm:ssZ)
     Tag 4 — মোট টাকা (VAT সহ), দুই দশমিক
     Tag 5 — মোট VAT, দুই দশমিক

   দ্বিতীয় ধাপে (Integration Phase) আরও চারটা যোগ হয় — Tag 6 XML-এর হ্যাশ,
   Tag 7 ডিজিটাল সই, Tag 8 পাবলিক কী, Tag 9 ZATCA-এর দেওয়া সার্টিফিকেটের সই।
   ওগুলো সার্ভারে সার্টিফিকেট দিয়ে বানাতে হয়, ব্রাউজারে নয় — তাই এই ফাইলে
   শুধু প্রথম ধাপের পাঁচটা আছে, আর দ্বিতীয় ধাপের জন্য বাড়তি ট্যাগ জোড়া
   দেওয়ার জায়গা রাখা হয়েছে (zatcaQrFromTlv)।

   ⚠️ সতর্কতা: এটা সরকারি কর-সংক্রান্ত কাজ। কোডটা লেখা হয়েছে ZATCA-এর নিজের
   নথি দেখে, এবং নিজেদের পরীক্ষায় ঠিক আছে। কিন্তু আসল দোকানে চালু করার আগে
   ZATCA-এর নিজের যাচাই-সরঞ্জাম (Compliance & Enablement Toolbox SDK) দিয়ে
   একবার মিলিয়ে নেওয়া দরকার — সেটাই চূড়ান্ত প্রমাণ।
   ============================================================ */
(function (root) {
  "use strict";

  var enc = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;

  /* লেখাটাকে UTF-8 বাইটে বদলানো। বাংলা বা আরবি অক্ষর এক বাইটে ধরে না —
     একেকটা অক্ষর ২-৪ বাইট নেয়। TLV-এর length ঘরে অক্ষরের সংখ্যা নয়,
     বাইটের সংখ্যা বসাতে হয়। এখানে ভুল করলে QR স্ক্যানে ভেঙে যায়। */
  function utf8Bytes(str) {
    var s = String(str == null ? "" : str);
    if (enc) return enc.encode(s);
    // খুব পুরনো ব্রাউজারের জন্য বিকল্প
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else {
        i++;
        c = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  /* TLV-এর দৈর্ঘ্যের ঘর মাত্র এক বাইট — তাই কোনো মান ২৫৫ বাইটের বেশি হতে
     পারে না। দোকানের নাম লম্বা হলে ছেঁটে নিতে হয়, কিন্তু অক্ষরের মাঝখানে
     কাটা যাবে না (তাহলে ভাঙা অক্ষর তৈরি হয়)। তাই শেষ থেকে একটা একটা অক্ষর
     বাদ দিয়ে মাপে আনা হয়। */
  function truncateToBytes(str, maxBytes) {
    var s = String(str == null ? "" : str);
    if (utf8Bytes(s).length <= maxBytes) return s;
    while (s.length > 0 && utf8Bytes(s).length > maxBytes) s = s.slice(0, -1);
    return s;
  }

  function tlv(tag, value) {
    var v = utf8Bytes(truncateToBytes(value, 255));
    var out = new Uint8Array(2 + v.length);
    out[0] = tag & 0xff;
    out[1] = v.length & 0xff;
    out.set(v, 2);
    return out;
  }

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), at = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], at); at += list[i].length; }
    return out;
  }

  function bytesToBase64(bytes) {
    var bin = "", i, CH = 0x8000;   // একবারে খুব বড় টুকরো দিলে কিছু ব্রাউজার আটকে যায়
    for (i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }

  /* টাকার অঙ্ক সবসময় দুই দশমিকে। toFixed() একা ভরসা করা যায় না — 1.005-এর
     মতো সংখ্যায় দশমিকের ভাসমান হিসাবের কারণে ভুল দিকে গোল হয়। তাই আগে
     ১০০ দিয়ে গুণ করে গোল করা হয়। */
  function money(n) {
    var x = Number(n);
    if (!isFinite(x)) x = 0;
    return (Math.round((x + Number.EPSILON) * 100) / 100).toFixed(2);
  }

  /* সময় সবসময় UTC-তে, সেকেন্ড পর্যন্ত — যেমন 2026-09-18T09:05:00Z */
  function zatcaTimestamp(d) {
    var dt = (d instanceof Date) ? d : new Date(d || Date.now());
    if (isNaN(dt.getTime())) dt = new Date();
    return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /* সৌদি VAT নম্বর ১৫ অঙ্কের, শুরু ও শেষ হয় ৩ দিয়ে। ভুল নম্বর দিয়ে QR
     বানালে সেটা নিয়ম মানবে না — তাই আলাদা করে যাচাই করার সুযোগ রাখা হলো। */
  function isValidVatNumber(v) {
    var s = String(v == null ? "" : v).replace(/\s/g, "");
    return /^3\d{13}3$/.test(s);
  }

  /* মূল কাজ — প্রথম ধাপের পাঁচটা ট্যাগ দিয়ে QR-এর লেখা বানানো */
  function zatcaQrBase64(inv) {
    inv = inv || {};
    return bytesToBase64(concatBytes([
      tlv(1, inv.sellerName),
      tlv(2, String(inv.vatNumber == null ? "" : inv.vatNumber).replace(/\s/g, "")),
      tlv(3, zatcaTimestamp(inv.timestamp)),
      tlv(4, money(inv.totalWithVat)),
      tlv(5, money(inv.vatTotal))
    ]));
  }

  /* দ্বিতীয় ধাপে বাড়তি ট্যাগ (৬-৯) জোড়া দেওয়ার জন্য — extra = {6:"...",7:"..."} */
  function zatcaQrFromTlv(inv, extra) {
    var parts = [
      tlv(1, inv.sellerName),
      tlv(2, String(inv.vatNumber == null ? "" : inv.vatNumber).replace(/\s/g, "")),
      tlv(3, zatcaTimestamp(inv.timestamp)),
      tlv(4, money(inv.totalWithVat)),
      tlv(5, money(inv.vatTotal))
    ];
    if (extra) {
      [6, 7, 8, 9].forEach(function (t) {
        if (extra[t] != null && extra[t] !== "") parts.push(tlv(t, extra[t]));
      });
    }
    return bytesToBase64(concatBytes(parts));
  }

  /* নিজেদের বানানো QR আবার পড়ে দেখার জন্য — পরীক্ষা ও সমস্যা খোঁজার কাজে */
  function zatcaQrDecode(b64) {
    var bin = atob(String(b64));
    var bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var out = {}, p = 0, dec = (typeof TextDecoder !== "undefined") ? new TextDecoder() : null;
    while (p < bytes.length) {
      var tag = bytes[p], len = bytes[p + 1];
      if (p + 2 + len > bytes.length) throw new Error("QR-এর দৈর্ঘ্য মেলেনি (tag " + tag + ")");
      var slice = bytes.subarray(p + 2, p + 2 + len);
      out[tag] = dec ? dec.decode(slice) : String.fromCharCode.apply(null, slice);
      p += 2 + len;
    }
    return out;
  }

  /* VAT-সহ মোট থেকে VAT বের করা। সৌদিতে দোকানে টাঙানো দামে VAT ধরাই থাকে,
     তাই মোট টাকার ভেতর থেকেই VAT আলাদা করতে হয়:  VAT = মোট × হার/(১০০+হার) */
  function vatFromInclusive(totalWithVat, ratePercent) {
    var rate = Number(ratePercent);
    if (!isFinite(rate)) rate = 15;
    var total = Number(totalWithVat) || 0;
    return Math.round(((total * rate) / (100 + rate) + Number.EPSILON) * 100) / 100;
  }

  root.ZatcaQR = {
    base64: zatcaQrBase64,
    withExtraTags: zatcaQrFromTlv,
    decode: zatcaQrDecode,
    timestamp: zatcaTimestamp,
    money: money,
    isValidVatNumber: isValidVatNumber,
    vatFromInclusive: vatFromInclusive,
    _utf8Bytes: utf8Bytes,
    _truncateToBytes: truncateToBytes
  };
})(typeof window !== "undefined" ? window : globalThis);
