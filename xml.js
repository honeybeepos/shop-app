/* ============================================================
   functions/zatca/xml.js — কর চালানের XML (UBL 2.1) তৈরি

   ZATCA-র দ্বিতীয় ধাপে চালান পাঠাতে হয় একটা নির্দিষ্ট রূপের XML হিসেবে
   (UBL 2.1)। সেই XML-এর হ্যাশ বের করে তাতে ডিজিটাল সই বসাতে হয়।

   ── কেন বাইরের কোনো XML লাইব্রেরি ব্যবহার করা হয়নি ──

   হ্যাশ বের করার আগে XML-টাকে "canonical" রূপে আনতে হয় — মানে একটা
   নির্দিষ্ট আদর্শ লেখার ধরন, যাতে একই তথ্য সবসময় হুবহু একই বাইট দেয়।
   সাধারণত এর জন্য লাইব্রেরি ব্যবহার করে XML লিখে, পড়ে, আবার canonical
   করে লেখা হয় — তিনবার ঘোরাঘুরি, আর প্রতিটা ধাপে হ্যাশ বদলে যাওয়ার
   সুযোগ।

   এখানে অন্য পথ নেওয়া হয়েছে: XML-টা **প্রথম থেকেই canonical রূপে**
   লেখা হয়। তাহলে আর কিছু করার দরকারই থাকে না — যা লিখেছি, তারই হ্যাশ।
   এর জন্য কয়েকটা নিয়ম কড়াভাবে মানতে হয়, নিচের লেখকটা সেগুলোই মানে:

     • খালি এলিমেন্টও পুরো লিখতে হয় (<a></a>, কখনো <a/> নয়)
     • এলিমেন্টের মাঝে কোনো বাড়তি ফাঁকা জায়গা/নতুন লাইন থাকবে না
     • নেমস্পেস আগে, তারপর বাকি অ্যাট্রিবিউট — দুটোই নাম ধরে সাজানো
     • &, <, > — টেক্সটে; &, <, ", আর ট্যাব/নতুন লাইন — অ্যাট্রিবিউটে
     • XML ঘোষণার লাইন (<?xml ...?>) canonical রূপে থাকে না

   ⚠️ যেটা এখনো প্রমাণ হয়নি: এই XML ZATCA-র পুরো স্কিমা ও সব ব্যবসায়িক
   নিয়ম (schema + schematron) মানে কিনা। সেটা ZATCA-র নিজের SDK ছাড়া
   যাচাই করা যায় না।
   ============================================================ */
"use strict";

/* ---- ZATCA-র ঠিক করে দেওয়া ধ্রুবক ----
   এক জায়গায় রাখা হলো, যাতে দরকার হলে শুধু এখানেই বদলাতে হয়।
   profileId আর currency — দুটোই ZATCA-র XML Implementation Standard-এ
   নিয়ম হিসেবে লেখা আছে (BR-KSA-EN16931-01 ও -02), সেখান থেকে মিলিয়ে
   নেওয়া হয়েছে। */
const ZATCA_CONST = {
  profileId: "reporting:1.0",          // BR-KSA-EN16931-01 — সরকারি নথি থেকে যাচাই করা
  invoiceTypeCode: "388",              // 388 = কর চালান
  simplifiedSubtype: "0200000",        // ০২ = সরলীকৃত (B2C)
  standardSubtype: "0100000",          // ০১ = সাধারণ (B2B)
  currency: "SAR",                     // BR-KSA-EN16931-02 — সরকারি নথি থেকে যাচাই করা
  vatScheme: "VAT",
  countryCode: "SA"
};

const NS = {
  "": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"
};

/* টেক্সটের ভেতরের বিশেষ অক্ষর। canonical রূপে > -ও বদলাতে হয়, আর
   ক্যারেজ-রিটার্ন সংখ্যা-রূপে লিখতে হয় (নাহলে পড়ার সময় হারিয়ে যায়)। */
function escText(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}
function escAttr(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

/* একটা এলিমেন্ট লেখা। attrs-এর চাবিগুলো নাম ধরে সাজানো হয় — canonical
   রূপের দাবি, আর এতে একই তথ্য সবসময় একই বাইট দেয়। */
function el(name, attrs, inner) {
  var a = "";
  if (attrs) {
    Object.keys(attrs).sort().forEach(function (k) {
      if (attrs[k] == null) return;
      a += " " + k + '="' + escAttr(attrs[k]) + '"';
    });
  }
  return "<" + name + a + ">" + (inner == null ? "" : inner) + "</" + name + ">";
}
function t(name, value, attrs) { return el(name, attrs, escText(value)); }

/* টাকার অঙ্ক — দুই দশমিক, আর গোল করার সময় ভাসমান দশমিকের ফাঁদ এড়ানো */
function amt(n) {
  var x = Number(n);
  if (!isFinite(x)) x = 0;
  return (Math.round((x + Number.EPSILON) * 100) / 100).toFixed(2);
}
function qty(n) {
  var x = Number(n);
  if (!isFinite(x)) x = 0;
  return String(Math.round((x + Number.EPSILON) * 1000000) / 1000000);
}

function partyBlock(tag, p, withVat) {
  var addr = p.address || {};
  var inner =
    el("cac:Party", null,
      (p.partyIdScheme && p.partyId
        ? el("cac:PartyIdentification", null,
            t("cbc:ID", p.partyId, { schemeID: p.partyIdScheme }))
        : "") +
      el("cac:PostalAddress", null,
        t("cbc:StreetName", addr.streetName || "") +
        t("cbc:BuildingNumber", addr.buildingNumber || "") +
        t("cbc:CitySubdivisionName", addr.district || "") +
        t("cbc:CityName", addr.city || "") +
        t("cbc:PostalZone", addr.postalCode || "") +
        el("cac:Country", null, t("cbc:IdentificationCode", addr.countryCode || ZATCA_CONST.countryCode))) +
      (withVat
        ? el("cac:PartyTaxScheme", null,
            t("cbc:CompanyID", p.vatNumber || "") +
            el("cac:TaxScheme", null, t("cbc:ID", ZATCA_CONST.vatScheme)))
        : "") +
      el("cac:PartyLegalEntity", null, t("cbc:RegistrationName", p.legalName || "")));
  return el(tag, null, inner);
}

/* ---- মূল কাজ ----
   opts:
     invoiceNumber, uuid, issueDate (YYYY-MM-DD), issueTime (HH:mm:ss),
     icv, pih, qr, invoiceType ('simplified'|'standard'),
     seller {legalName, vatNumber, crNumber, address{...}},
     buyer (ঐচ্ছিক, B2B-তে লাগে),
     vatRate, lines [{name, quantity, unitPrice, netAmount, vatAmount}],
     netTotal, vatTotal, grossTotal
     signatureXml (ঐচ্ছিক — সই বসানোর পর ext:UBLExtensions-এর ভেতরটা)
*/
function buildInvoiceXml(opts) {
  opts = opts || {};
  var isSimplified = (opts.invoiceType || "simplified") === "simplified";
  var subtype = isSimplified ? ZATCA_CONST.simplifiedSubtype : ZATCA_CONST.standardSubtype;
  var rate = (opts.vatRate == null) ? 15 : Number(opts.vatRate);
  var lines = Array.isArray(opts.lines) ? opts.lines : [];

  /* নেমস্পেসগুলো মূল এলিমেন্টে, prefix ধরে সাজানো — canonical রূপে
     xmlns (ডিফল্ট) আগে, তারপর বাকিগুলো বর্ণক্রমে। */
  var rootNs = ' xmlns="' + NS[""] + '"' +
               ' xmlns:cac="' + NS.cac + '"' +
               ' xmlns:cbc="' + NS.cbc + '"' +
               ' xmlns:ext="' + NS.ext + '"';

  var ublExt = opts.signatureXml
    ? el("ext:UBLExtensions", null, opts.signatureXml)
    : "";

  var head =
    t("cbc:ProfileID", ZATCA_CONST.profileId) +
    t("cbc:ID", opts.invoiceNumber || "") +
    t("cbc:UUID", opts.uuid || "") +
    t("cbc:IssueDate", opts.issueDate || "") +
    t("cbc:IssueTime", opts.issueTime || "") +
    t("cbc:InvoiceTypeCode", ZATCA_CONST.invoiceTypeCode, { name: subtype }) +
    t("cbc:DocumentCurrencyCode", ZATCA_CONST.currency) +
    t("cbc:TaxCurrencyCode", ZATCA_CONST.currency);

  // ক্রমিক নম্বর (ICV) আর আগের চালানের হ্যাশ (PIH) — শেকলটা এখানেই
  var icvRef = el("cac:AdditionalDocumentReference", null,
    t("cbc:ID", "ICV") + t("cbc:UUID", String(opts.icv == null ? "" : opts.icv)));
  var pihRef = el("cac:AdditionalDocumentReference", null,
    t("cbc:ID", "PIH") +
    el("cac:Attachment", null,
      t("cbc:EmbeddedDocumentBinaryObject", opts.pih || "", { mimeCode: "text/plain" })));
  var qrRef = opts.qr
    ? el("cac:AdditionalDocumentReference", null,
        t("cbc:ID", "QR") +
        el("cac:Attachment", null,
          t("cbc:EmbeddedDocumentBinaryObject", opts.qr, { mimeCode: "text/plain" })))
    : "";

  var sigBlock = opts.includeSignatureRef
    ? el("cac:Signature", null,
        t("cbc:ID", "urn:oasis:names:specification:ubl:signature:Invoice") +
        t("cbc:SignatureMethod", "urn:oasis:names:specification:ubl:dsig:enveloped:xades"))
    : "";

  var parties =
    partyBlock("cac:AccountingSupplierParty", opts.seller || {}, true) +
    (opts.buyer ? partyBlock("cac:AccountingCustomerParty", opts.buyer, !!opts.buyer.vatNumber) : "");

  // ভ্যাটের যোগফল দুইবার আসে — একবার শুধু অঙ্ক, একবার ভাগ করে দেখানো
  var taxTotalSimple = el("cac:TaxTotal", null,
    t("cbc:TaxAmount", amt(opts.vatTotal), { currencyID: ZATCA_CONST.currency }));
  var taxTotalDetail = el("cac:TaxTotal", null,
    t("cbc:TaxAmount", amt(opts.vatTotal), { currencyID: ZATCA_CONST.currency }) +
    el("cac:TaxSubtotal", null,
      t("cbc:TaxableAmount", amt(opts.netTotal), { currencyID: ZATCA_CONST.currency }) +
      t("cbc:TaxAmount", amt(opts.vatTotal), { currencyID: ZATCA_CONST.currency }) +
      el("cac:TaxCategory", null,
        t("cbc:ID", "S", { schemeAgencyID: "6", schemeID: "UN/ECE 5305" }) +
        t("cbc:Percent", amt(rate)) +
        el("cac:TaxScheme", null,
          t("cbc:ID", ZATCA_CONST.vatScheme, { schemeAgencyID: "6", schemeID: "UN/ECE 5153" })))));

  var monetary = el("cac:LegalMonetaryTotal", null,
    t("cbc:LineExtensionAmount", amt(opts.netTotal), { currencyID: ZATCA_CONST.currency }) +
    t("cbc:TaxExclusiveAmount", amt(opts.netTotal), { currencyID: ZATCA_CONST.currency }) +
    t("cbc:TaxInclusiveAmount", amt(opts.grossTotal), { currencyID: ZATCA_CONST.currency }) +
    t("cbc:PayableAmount", amt(opts.grossTotal), { currencyID: ZATCA_CONST.currency }));

  var invoiceLines = lines.map(function (ln, i) {
    return el("cac:InvoiceLine", null,
      t("cbc:ID", String(i + 1)) +
      t("cbc:InvoicedQuantity", qty(ln.quantity == null ? 1 : ln.quantity), { unitCode: ln.unitCode || "PCE" }) +
      t("cbc:LineExtensionAmount", amt(ln.netAmount), { currencyID: ZATCA_CONST.currency }) +
      el("cac:TaxTotal", null,
        t("cbc:TaxAmount", amt(ln.vatAmount), { currencyID: ZATCA_CONST.currency }) +
        t("cbc:RoundingAmount", amt(Number(ln.netAmount) + Number(ln.vatAmount)), { currencyID: ZATCA_CONST.currency })) +
      el("cac:Item", null,
        t("cbc:Name", ln.name || "") +
        el("cac:ClassifiedTaxCategory", null,
          t("cbc:ID", "S", { schemeAgencyID: "6", schemeID: "UN/ECE 5305" }) +
          t("cbc:Percent", amt(rate)) +
          el("cac:TaxScheme", null,
            t("cbc:ID", ZATCA_CONST.vatScheme, { schemeAgencyID: "6", schemeID: "UN/ECE 5153" })))) +
      el("cac:Price", null,
        t("cbc:PriceAmount", amt(ln.unitPrice), { currencyID: ZATCA_CONST.currency })));
  }).join("");

  return "<Invoice" + rootNs + ">" +
    ublExt + head + icvRef + pihRef + qrRef + sigBlock +
    parties + taxTotalSimple + taxTotalDetail + monetary + invoiceLines +
    "</Invoice>";
}

/* হ্যাশ বের করার জন্য যে রূপটা লাগে — ZATCA বলে দিয়েছে হ্যাশের আগে
   তিনটা জিনিস বাদ দিতে হবে: ext:UBLExtensions, cac:Signature, আর
   QR-এর AdditionalDocumentReference। আমরা যেহেতু XML-টা নিজেরাই লিখি,
   তাই ওগুলো কেটে বাদ দেওয়ার বদলে শুরু থেকেই ছাড়া লিখে ফেলা হয় —
   কাটাকুটির কোনো সুযোগই থাকে না। */
function buildHashableXml(opts) {
  var o = Object.assign({}, opts);
  delete o.signatureXml;
  o.qr = null;
  o.includeSignatureRef = false;
  return buildInvoiceXml(o);
}

module.exports = { buildInvoiceXml, buildHashableXml, ZATCA_CONST, NS, _escText: escText, _escAttr: escAttr, _amt: amt };
