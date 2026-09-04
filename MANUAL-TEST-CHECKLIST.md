# 🐝 Auto-Dispatch Engine — ম্যানুয়াল টেস্ট চেকলিস্ট

এটা Firebase Console (Firestore ট্যাব) থেকে হাতে-কলমে চালানোর জন্য।
প্রতিটা ধাপের পর ফলাফল "প্রকৃত" কলামে লিখে PASS/FAIL টিক দিন।

⚠️ **সব টেস্ট ডকুমেন্টের ID/নামে `TEST_` prefix ব্যবহার করুন**, যাতে আসল
ডেটা থেকে সহজে আলাদা করা যায় এবং শেষে নিরাপদে মুছে ফেলা যায়।

---

## ধাপ ০ — টেস্ট ডেটা তৈরি (একবারই)

Firestore Console → নিচের ৪টা ডকুমেন্ট হাতে তৈরি করুন:

**`shops/TEST_SHOP_1`**
```
name: "TEST দোকান"
marketId: "TEST_MARKET_1"
storeLocation: { lat: 23.8103, lng: 90.4125 }
```

**`riders/TEST_RIDER_1`**
```
name: "TEST রাইডার ১"
status: "active"
online: false
transportModeOn: false
currentStatus: "offline"
marketId: "TEST_MARKET_1"
liveLocation: { lat: 23.8110, lng: 90.4130 }
```

**`riders/TEST_RIDER_2`** — একই, নাম "TEST রাইডার ২", marketId `"TEST_MARKET_2"` (ভিন্ন মার্কেট)

**`riders/TEST_RIDER_3`** — একই, নাম "TEST রাইডার ৩", marketId `"TEST_MARKET_1"`

---

## ১. Firestore Index যাচাই

- [ ] Firebase Console → Functions → Logs-এ যান
- [ ] নিচের ধাপ ৩-এর টেস্ট চালানোর পর "FAILED_PRECONDITION" বা "index" শব্দযুক্ত কোনো এরর আছে কিনা দেখুন
- [ ] থাকলে: লগে একটা ক্লিকযোগ্য লিংক থাকবে যেটাতে ক্লিক করলে সরাসরি সঠিক index তৈরি হয়ে যায় — **সেই লিংকটাই ব্যবহার করুন**, ম্যানুয়ালি টাইপ করবেন না

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| riders কোয়েরি (online+transportModeOn+status+currentStatus) index এরর নেই | কোনো এরর নেই বা এরর-লিংক দিয়ে index তৈরি হয়েছে | | |
| orderRequests কোয়েরি (assignedRiderId+status) index এরর নেই | কোনো এরর নেই বা এরর-লিংক দিয়ে index তৈরি হয়েছে | | |

---

## ৩. Rider Online/Offline Status

1. `riders/TEST_RIDER_1`-এ `online` ফিল্ডে ক্লিক করে `true` করুন
2. ৫ সেকেন্ড অপেক্ষা করে পেজ রিফ্রেশ করুন

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| Online করার পর currentStatus | `"available"` | | |

3. এবার `online` ফিল্ডে `false` করুন, ৫ সেকেন্ড পর রিফ্রেশ

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| Offline করার পর currentStatus | `"offline"` | | |

---

## ৪. Transport Protection

`riders/TEST_RIDER_1`-এ একসাথে বসান:
```
online: true
transportModeOn: true
currentStatus: "on_trip"
activeTripId: "TEST_TRIP_001"
```
এবার Rider Mode অ্যাপ থেকে (অথবা Firestore-এ সরাসরি) Online/Offline টগল করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| Toggle করার পরও currentStatus | এখনো `"on_trip"` (বদলায়নি) | | |

**টেস্ট শেষে রিসেট করুন:** `transportModeOn: false, currentStatus: "available", activeTripId` মুছে দিন।

---

## ৫. স্বয়ংক্রিয় Dispatch Trigger

`orderRequests/TEST_ORDER_1` তৈরি করুন:
```
shopId: "TEST_SHOP_1"
productName: "TEST প্রোডাক্ট"
customerName: "TEST কাস্টমার"
deliveryAddress: "TEST ঠিকানা"
deliveryPhone: "01700000001"
deliveryLat: 23.8095
deliveryLng: 90.4140
qty: 1
status: "pending"
```
নিশ্চিত করুন `TEST_RIDER_1` অনলাইন+available আছে (ধাপ ৩)।
এবার `status` ফিল্ড বদলে `"preparing"` করুন।

৩০ সেকেন্ড অপেক্ষা করে রিফ্রেশ করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| dispatchState তৈরি হয়েছে | `"offer_sent"` অথবা `"searching_rider"` | | |
| currentOfferId ফিল্ড আছে | একটা ID | | |
| deliveryOffers-এ সেই ID-র ডকুমেন্ট আছে | orderId, riderId, status:"pending", expiresAt সব আছে | | |
| expiresAt − createdAt | ≈ ৬০ সেকেন্ড | | |

---

## ৮. Rider Accept

ওপরের অফার ডকুমেন্টে (`deliveryOffers/{offerId}`) গিয়ে `status` বদলে `"accepted"` করুন।
১০ সেকেন্ড পর `orderRequests/TEST_ORDER_1` রিফ্রেশ করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| status | `"shipped"` | | |
| dispatchState | `"assigned"` | | |
| assignedRiderId | `TEST_RIDER_1`-এর UID | | |
| assignedRiderName | রাইডারের নাম | | |

---

## ৯. Rider Reject

নতুন `orderRequests/TEST_ORDER_2` একইভাবে তৈরি করুন (ধাপ ৫-এর মতো), `TEST_RIDER_1` আবার available করুন, status `"preparing"` করুন, অফার তৈরি হওয়ার অপেক্ষা করুন।
সেই অফারে `status` বদলে `"skipped"` করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| Reject-এর পর dispatchState | আবার `"offer_sent"` (যদি আরেকজন এলিজিবল রাইডার থাকে) অথবা `"waiting_for_rider"` | | |
| দোকানদারকে কিছু করতে হয়নি | ✅ স্বয়ংক্রিয় | | |

---

## ১০. ৬০ সেকেন্ড Timeout

নতুন `orderRequests/TEST_ORDER_X` তৈরি করে dispatch trigger করুন। এবার অফারে **কিছুই করবেন না** — শুধু অপেক্ষা করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| ~২ মিনিট পর (scheduled function-এর জন্য) offer.status | `"expired"` | | |
| এরপর dispatchState | পরের রাইডারকে অফার অথবা `waiting_for_rider` | | |

---

## ১১. কোনো রাইডার নেই

সব TEST রাইডারকে `online: false` করুন। নতুন অর্ডার তৈরি করে `preparing` করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| status | এখনো `"preparing"` (বাতিল হয়নি) | | |
| dispatchState | `"waiting_for_rider"` | | |
| POS-এ বার্তা দেখাচ্ছে | "⚠️ এই মুহূর্তে কোনো Delivery Rider Duty-তে নেই..." | | |

---

## ১২. Rider Online হলে Queue পুনর্মূল্যায়ন

ওপরের `waiting_for_rider` অর্ডারটা রেখেই — `TEST_RIDER_2`-কে online+available করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| ৩০ সেকেন্ডের মধ্যে dispatchState | `"offer_sent"`-এ ফিরেছে | | |
| দোকানদারকে কিছু করতে হয়নি | ✅ স্বয়ংক্রিয় | | |

---

## ১৩. Transport Mode বাদ

`TEST_RIDER_3`-কে `online:true, transportModeOn:true, currentStatus:"available"` করুন (আর কোনো এলিজিবল রাইডার অনলাইনে না রেখে)। নতুন অর্ডার তৈরি করে dispatch trigger করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| TEST_RIDER_3 অফার পায় | ❌ পায় না (dispatchState waiting_for_rider থাকবে) | | |

এবার `transportModeOn: false` করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| এখন এলিজিবল হয়ে অফার পায় | ✅ | | |

---

## ১৪. Duplicate Accept

একটা অফার-পাওয়া অর্ডারে, **দুটো ব্রাউজার ট্যাব খুলে** প্রায় একইসাথে অফার ডকুমেন্টে `status: "accepted"` লেখার চেষ্টা করুন (বাস্তবে এটা সিমুলেট করা কঠিন Console থেকে — বিকল্প: Cloud Function লগে `DUPLICATE_ASSIGNMENT_BLOCKED` কখনো এসেছে কিনা পুরনো লগ ঘেঁটে দেখুন, অথবা স্বয়ংক্রিয় স্ক্রিপ্টে এটা আরও নির্ভরযোগ্যভাবে টেস্ট হয়)।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| শুধু একজন assignedRiderId হয় | ✅ | | |

---

## ১৫. Manual Fallback UI

POS-এ "📦 অর্ডার ব্যবস্থাপনা" → "প্রস্তুত হচ্ছে" ট্যাবে যান।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| dispatchState=offer_sent অর্ডারে | শুধু স্ট্যাটাস-টেক্সট, রাইডার-ড্রপডাউন নেই | | |
| dispatchState=waiting_for_rider অর্ডারে | "⚠️ জরুরি ম্যানুয়াল Assignment" + ড্রপডাউন দেখা যায় | | |

---

## ১৬. POS রিয়েল-টাইম আপডেট

POS-এর "📦 অর্ডার ব্যবস্থাপনা" খোলা রেখে, অন্য ট্যাবে Firestore-এ গিয়ে একটা অফার accept করুন।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| POS পেজ রিফ্রেশ ছাড়াই আপডেট হয় | ✅ রাইডারের নাম/স্ট্যাটাস দেখা যায় | | |

---

## ১৭. FCM

- [ ] VAPID key `shop-ledger-app.html`-এ বসানো আছে? (না থাকলে **BLOCKED** লিখুন, বাকি সাব-টেস্ট চালানোর দরকার নেই)
- [ ] থাকলে: রাইডার অ্যাপ খোলা রেখে টেস্ট অফার পাঠান → নোটিফিকেশন এলো?
- [ ] রাইডার অ্যাপ ব্যাকগ্রাউন্ডে রেখে টেস্ট → নোটিফিকেশন এলো?
- [ ] রাইডার অ্যাপ পুরো বন্ধ রেখে টেস্ট → নোটিফিকেশন এলো?

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL/BLOCKED |
|---|---|---|---|
| Foreground | নোটিফিকেশন + Bee Alert শব্দ | | |
| Background | নোটিফিকেশন | | |
| বন্ধ অ্যাপ | নোটিফিকেশন | | |

---

## ১৮. Legacy সিস্টেম অক্ষত আছে কিনা

- [ ] একটা পুরনো/legacy শপ থেকে "🔔 ডেলিভারি ম্যান কে ডাকুন" চেপে দেখুন — আগের মতোই কাজ করে?
- [ ] Transport Mode-এ একটা টেস্ট ট্রিপ রিকোয়েস্ট করে দেখুন — trip dispatch আগের মতোই কাজ করে?

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| Legacy deliveryCalls dispatch | অপরিবর্তিত কাজ করে | | |
| Transport/Trip dispatch | অপরিবর্তিত কাজ করে | | |

---

## ১৯. Cloud Log যাচাই

Firebase Console → Functions → Logs-এ গিয়ে ওপরের টেস্টগুলো চালানোর সময়ের লগ দেখুন।

| খুঁজুন | পাওয়া গেছে? |
|---|---|
| `ORDER_DISPATCH_STARTED` | |
| `RIDER_SELECTED` | |
| `OFFER_CREATED` | |
| `NO_RIDER_AVAILABLE` (ধাপ ১১-এর সময়) | |
| `QUEUE_RETRY` (ধাপ ১২-এর সময়) | |
| `ORDER_ASSIGNED` (ধাপ ৮-এর সময়) | |
| কোনো customer ফোন/ঠিকানা লগে দেখা যাচ্ছে না | ✅/❌ |

---

## ২০. Cost/পোলিং যাচাই

Firebase Console → Functions → প্রতিটা ফাংশনের invocation count দেখুন টেস্ট চালানোর আগে ও পরে।

| Test | প্রত্যাশিত | প্রকৃত | PASS/FAIL |
|---|---|---|---|
| `onOrderConfirmed` invocation সংখ্যা | টেস্ট-অর্ডার সংখ্যার সমান (বারবার না) | | |
| Distance Matrix API কল (Google Cloud Console-এ) | dispatch-প্রতি সর্বোচ্চ ১-২টা | | |

---

## চূড়ান্ত সারাংশ টেবিল

| সেকশন | PASS | FAIL | BLOCKED |
|---|---|---|---|
| ১-২০ | | | |

---

## 🧹 টেস্ট শেষে পরিষ্কার করা

সব `TEST_` prefix-যুক্ত ডকুমেন্ট মুছে ফেলুন:
- `shops/TEST_SHOP_1`
- `riders/TEST_RIDER_1`, `TEST_RIDER_2`, `TEST_RIDER_3`
- `orderRequests/TEST_ORDER_*` (সবগুলো)
- `deliveryOffers/` — যেগুলোর `orderId` TEST_ order-এর দিকে নির্দেশ করে
