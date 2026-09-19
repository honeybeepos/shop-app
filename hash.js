/* ============================================================
   functions/zatca/hash.js — চালানের হ্যাশ আর হ্যাশের শেকল

   ZATCA-র নিয়ম: প্রতিটা চালানের XML-এর SHA-256 হ্যাশ বের করতে হয়, আর
   প্রতিটা চালানে আগের চালানের হ্যাশটাও বসিয়ে দিতে হয় (PIH)। এতে
   চালানগুলো একটা শেকলে বাঁধা পড়ে যায় — মাঝখান থেকে একটা চালান সরিয়ে
   দিলে বা বদলে দিলে পরের চালানের শেকল আর মেলে না, সাথে সাথে ধরা পড়ে।

   জরুরি: ZATCA স্পষ্ট বলেছে, **যে চালান ওরা বাতিল করে দিয়েছে তার
   ক্ষেত্রেও** শেকলটা ভাঙা যাবে না — অর্থাৎ বাতিল হলেও ওই চালানের হ্যাশই
   পরেরটার PIH হবে। তাই এখানে "সফল হলে তবেই শেকলে যোগ করব" — এমন লোভনীয়
   কিন্তু ভুল কাজটা করা হয়নি।
   ============================================================ */
"use strict";

const crypto = require("crypto");
const { buildHashableXml } = require("./xml");

/* ---- একেবারে প্রথম চালানের PIH ----
   কোনো আগের চালান নেই, তাই শেকলের শুরুর গিঁট হিসেবে একটা নির্দিষ্ট মান
   ব্যবহার করা হয়: "0"-এর SHA-256, হেক্স হিসেবে লিখে, তারপর base64।
   এটা শিল্পে বহুল-ব্যবহৃত মান, কিন্তু ZATCA-র নথিতে আমরা এটা লেখা
   অবস্থায় পাইনি — তাই ❓ SDK দিয়ে মিলিয়ে নেওয়া দরকার। */
function firstPih() {
  const hex = crypto.createHash("sha256").update("0", "utf8").digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

/* চালানের হ্যাশ — SHA-256, base64।
   XML-টা আগে থেকেই canonical রূপে লেখা (xml.js দেখুন), তাই এখানে আর
   কোনো রূপান্তর লাগে না — যা লেখা হয়েছে হুবহু তারই হ্যাশ। */
function invoiceHashFromXml(canonicalXml) {
  const digest = crypto.createHash("sha256").update(Buffer.from(canonicalXml, "utf8")).digest();
  return { base64: digest.toString("base64"), hex: digest.toString("hex"), bytes: digest };
}

function invoiceHash(opts) {
  const xml = buildHashableXml(opts);
  const h = invoiceHashFromXml(xml);
  return { hashableXml: xml, hash: h.base64, hashHex: h.hex, hashBytes: h.bytes };
}

/* শেকলের পরের গিঁট। আগের চালান না থাকলে শুরুর গিঁট। */
function nextPih(previousInvoiceHashBase64) {
  return previousInvoiceHashBase64 || firstPih();
}

/* পুরো শেকলটা পরীক্ষা করা — প্রতিটা চালানের PIH আসলেই তার আগের চালানের
   হ্যাশ কিনা, আর ক্রমিক নম্বর ধারাবাহিক কিনা। কর খাতায় এটা নিয়মিত
   দেখা দরকার, কারণ শেকল ভাঙলে সেটা নিজে থেকে জানান দেয় না। */
function verifyChain(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  list.sort(function (a, b) { return (a.icv || 0) - (b.icv || 0); });
  const problems = [];
  let expectedPih = firstPih();
  let prevIcv = 0;

  list.forEach(function (r) {
    const icv = Number(r.icv);
    if (!isFinite(icv)) { problems.push("ক্রমিক নম্বর পড়া যায়নি"); return; }
    if (icv !== prevIcv + 1) {
      problems.push("ক্রমিক নম্বরে ফাঁক বা লাফ: " + prevIcv + " → " + icv);
    }
    prevIcv = icv;

    const pih = r.phase2 && r.phase2.previousInvoiceHash;
    const hash = r.phase2 && r.phase2.invoiceHash;
    if (!hash) return;                               // এখনো XML বানানো হয়নি — এটা ভুল নয়
    if (pih !== expectedPih) {
      problems.push("চালান #" + icv + "-এর শেকল মেলেনি (আগের হ্যাশ আলাদা)");
    }
    expectedPih = hash;
  });

  return { ok: problems.length === 0, problems: problems, checked: list.length };
}

module.exports = { firstPih, invoiceHash, invoiceHashFromXml, nextPih, verifyChain };
