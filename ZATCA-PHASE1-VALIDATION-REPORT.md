# ZATCA PHASE 1 VALIDATION REPORT

**Honey Bee POS** · তারিখ: ১৯ সেপ্টেম্বর ২০২৬

---

## সারাংশ

| আইটেম | ফল |
|---|---|
| QR Generator | **PASS** |
| **Official ZATCA SDK** | **PENDING** — নামানো যায়নি (নিচে কারণ) |
| Tag 1 — Seller Name | PASS |
| Tag 2 — VAT Registration Number | PASS |
| Tag 3 — Invoice Timestamp (UTC) | PASS |
| Tag 4 — Invoice Total incl. VAT | PASS |
| Tag 5 — VAT Total | PASS |
| Arabic QR | PASS |
| English QR | PASS |
| Thermal Print (384-dot) | PASS |
| Offline Generation | PASS |
| Fail-fast validation | PASS |

**Final: FIX REQUIRED নয় — কিন্তু PHASE 1 READY-ও লেখা যাচ্ছে না।**
**সঠিক অবস্থা: `INTERNAL VALIDATION PASSED · OFFICIAL SDK VALIDATION: PENDING`**

আপনি নিজে বলে দিয়েছেন — official SDK না পেলে PASS লেখা যাবে না। তাই লিখছি না।

---

## কেন Official SDK দিয়ে করা গেল না

চেষ্টা করা হয়েছে। ZATCA-এর সরকারি ডাউনলোড পাতা থেকে SDK-এর আসল ঠিকানা বের
করা গেছে, কিন্তু এই কাজের পরিবেশ থেকে সেই দুটো ঠিকানায় যাওয়ার অনুমতি নেই —
প্রতিষ্ঠানের নেটওয়ার্ক নীতিতে আটকানো:

```
sadzit.sharepoint.com:443   → 403 (policy denial)
mcusercontent.com:443       → 403 (policy denial)
```

এটা কোনো কারিগরি সমস্যা নয় যেটা ঘুরিয়ে সমাধান করা যায়, আর ঘুরপথে যাওয়ার
চেষ্টাও করিনি। তাই SDK-এর ঘরে **PENDING** লেখা।

**এই যাচাইটা আপনাকে নিজে করতে হবে।** তিনটা সরকারি পথ আছে:

১. **SDK নিজে নামিয়ে চালানো** — [ZATCA-এর ডাউনলোড পাতা](https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx)
   থেকে। সাথে ব্যবহারের নিয়মের PDF-ও ওখানেই আছে।

২. **ZATCA-এর নিজের মোবাইল অ্যাপ (ZATCA VAT app)** দিয়ে ছাপা রসিদের QR
   স্ক্যান করা — এটাই সবচেয়ে সহজ ও সরাসরি। অ্যাপটা QR-এর ভেতরের তথ্য
   দেখিয়ে দেয়, তখনই মিলিয়ে নেওয়া যায়। **তবে অ্যাপটা সৌদি আরবের ভেতর থেকে
   ব্যবহার করতে হয়** — ফাতুরা ডেভেলপার ফোরামে সেটা জানানো হয়েছে। বাংলাদেশ
   থেকে কাজ না-ও করতে পারে; সৌদির দোকানদারকে দিয়ে করাতে হবে।

৩. **সমস্যা হলে** — ZATCA-এর SP support (`sp_support@zatca.gov.sa`) বা
   [ফাতুরা ডেভেলপার ফোরাম](https://zatca1.discourse.group/)।

---

## যা যা পরীক্ষা করা হয়েছে

### Test A — ইংরেজি নাম

```
Seller : Honey Bee Technology
VAT    : 310122393500003
Total  : SAR 115.00
```
পাঁচটা ট্যাগই হুবহু মিলেছে। রসিদে SAR লেখা এসেছে।

### Test B — আরবি নাম

```
Seller : مؤسسة نحلة العسل للتقنية
```
নাম অবিকৃত ফিরে এসেছে। সবচেয়ে জরুরি জায়গাটা আলাদা করে মেপে দেখা হয়েছে:
TLV-এর দৈর্ঘ্যের ঘরে **৪৫** বসেছে, অথচ অক্ষর সংখ্যা **২৪** — অর্থাৎ
বাইট গোনা হয়েছে, অক্ষর নয়। এটাই ZATCA-এর নিয়ম, আর এখানেই বেশির ভাগ
বাস্তবায়ন ভুল করে।

### Test C — দামে ভ্যাট ধরা (VAT inclusive)

```
মোট ১১৫.০০  →  ভ্যাট ছাড়া ১০০.০০ · ভ্যাট ১৫.০০ · মোট ১১৫.০০
```
QR-এর Tag 4/5 রসিদের ছাপা সংখ্যার সাথে হুবহু এক।

### Test D — প্রান্তিক অঙ্ক

| মোট | Tag 4 | Tag 5 |
|---|---|---|
| 0 | 0.00 | 0.00 |
| 0.01 | 0.01 | 0.00 |
| 1.005 | 1.01 | 0.13 |
| 99.999 | 100.00 | 13.04 |
| 230.5 | 230.50 | 30.07 |
| 999999.99 | 999999.99 | 130434.78 |

সবগুলোতেই দুই দশমিক। সময়ও আলাদা করে দেখা হয়েছে: রিয়াদের ১২:০০ → UTC
০৯:০০, মিলিসেকেন্ড বাদ, রূপ `yyyy-MM-ddTHH:mm:ssZ`।

### Test E — থার্মাল প্রিন্ট

৩৮৪-ডট রসিদের আসল ছবি বানিয়ে সেটা **স্ক্যান করে** দেখা হয়েছে — ইংরেজি,
আরবি আর অফলাইন, তিনটাতেই পাঁচটা ট্যাগ ঠিকভাবে বেরিয়েছে।

### Test F — ইন্টারনেট বন্ধ

ব্রাউজার অফলাইন করে দিয়ে: বিক্রি, ভ্যাটের হিসাব, QR তৈরি, কাগজে ও থার্মালে
প্রিন্ট — সব কাজ করেছে, আর **একটাও বাইরের ঠিকানায় যাওয়া হয়নি**। (আলাদা
করে গুনে দেখা হয়েছে।)

---

## Fail-fast যাচাই (STEP 3)

আপনার কথামতো ভুল তথ্য আর চুপচাপ ঠিক করে নেওয়া হয় না:

| অবস্থা | আগে | এখন |
|---|---|---|
| ভুল ভ্যাট নম্বর | — | `Invalid Saudi VAT Registration Number` |
| নাম ২৫৫ বাইটের বেশি | চুপচাপ ছেঁটে দিত | ভুল বলে দেয়, ছোট করতে বলে |
| নাম খালি | — | ভুল বলে দেয় |
| ঋণাত্মক টাকা | — | ভুল বলে দেয় |
| ভ্যাট > মোট | — | ভুল বলে দেয় |
| সময় পড়া যায় না | — | ভুল বলে দেয় |

**কোথায় ধরা পড়ে:** প্রথমে সেটিংসে সেভ করার সময়েই — কাউন্টারে লাইন দাঁড়ানো
অবস্থায় নয়। তবু যদি প্রিন্টের সময় QR বানানো না যায়, তাহলে বিক্রি আটকে
দেওয়া হয় না (দোকান বন্ধ হয়ে যাবে), কিন্তু পর্দায় বার্তা আসে **আর রসিদের
গায়েই লেখা থাকে কেন QR নেই** — যাতে কেউ ভুল করে ওটাকে বৈধ কর চালান না ভাবে।

---

## QR Generator নিজে কতটা যাচাই হয়েছে

QR আঁকার অংশটা (`hb-qr.js`) নিজেদের লেখা, তাই আলাদা করে প্রমাণ দরকার ছিল।
OpenCV-তে সম্পূর্ণ স্বাধীন একটা QR এনকোডার আছে — তার সাথে ছক মিলিয়ে দেখা
হয়েছে:

- ৩২০টা QR, চারটা ভুল-সংশোধন স্তর, ২০টা ভার্সন
- **২০৭টা ছক ঘরে ঘরে হুবহু এক**
- বাকিগুলোর পার্থক্য: মুখোশ (mask) বাছাই আলাদা (দুটোই বৈধ), অথবা শেষের
  কয়েকটা অব্যবহৃত ঘর যেগুলো স্ক্যানার পড়েই না
- যেখানে আমাদের QR পড়া যায়নি, সেখানে OpenCV তার **নিজের** QR-ও পড়তে
  পারেনি — এবং ছক দুটো ছিল **হুবহু এক**। অর্থাৎ সীমাবদ্ধতা পাঠকের।

এই পরীক্ষায় একটা আসল বাগ ধরা পড়েছিল: format তথ্যের সারি ও কলাম উল্টে
গিয়েছিল, ফলে শুরুতে একটা QR-ও পড়া যাচ্ছিল না। ঠিক করা হয়েছে।

---

## স্পষ্ট করে বলা দরকার

**"Honey Bee POS এখন ZATCA certified" — এটা বলা যাবে না।** Certification
আসে ZATCA-এর নিজের যাচাই আর onboarding থেকে, আমাদের পরীক্ষা থেকে নয়।

যা বলা যায়: *"Phase 1-এর বাস্তবায়ন সম্পূর্ণ, আমাদের নিজেদের সব পরীক্ষায়
উত্তীর্ণ, ZATCA-এর নিজের যাচাই বাকি।"*

আর আগের মতোই — এটা আইনি কর বিষয়। আসল দোকানে চালু করার আগে সৌদির একজন
কর-উপদেষ্টাকে দিয়ে দেখিয়ে নেবেন।

---

## বর্তমান অবস্থা

```
Phase 1 POS Implementation     = COMPLETE
Internal Validation            = PASSED
Official ZATCA SDK Validation  = PENDING
Phase 2                        = NOT STARTED
```

Phase 2 শুরু করা হয়নি, আর আপনার অনুমতি ছাড়া শুরু করা হবে না।

---

## সূত্র

- [ZATCA — Download SDK](https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx)
- [ZATCA — Systems Developers](https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/default.aspx)
- [ZATCA — Guide to Developed FATOORA Compliant QR Code](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/QRCodeCreation.pdf)
- [ZATCA — E-Invoicing Detailed Technical Guideline](https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/E-invoicing-Detailed-Technical-Guideline.pdf)
- [Fatoora Developer Community — ZATCA VAT app দিয়ে QR স্ক্যান](https://zatca1.discourse.group/t/unable-to-scan-qr-code-using-the-zatca-vat-app/1162)
- [Fatoora Developer Community](https://zatca1.discourse.group/)
