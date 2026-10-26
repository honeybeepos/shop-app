/* =====================================================================
   🐝 বিনা খরচের মৌ — AI (Gemini) ছাড়া
   ---------------------------------------------------------------------
   সুপার এডমিন appConfig/mou ডকে  aiEnabled: true  না বসানো পর্যন্ত মৌ
   কোনো AI ডাকে না — খরচ শূন্য। তখন এই ফাইল গ্রাহকের লেখা থেকে শব্দ
   দেখে বোঝে কী চাইছেন:
     • দর্জি/সেলাই/ব্লাউজ…        → দর্জির ডিজাইন খোঁজা
     • রেস্টুরেন্ট/খাবার/বিরিয়ানি…  → রেস্টুরেন্ট খোঁজা
     • "আমার অর্ডার কোথায়"…        → নিজের অর্ডারের খবর
     • "কীভাবে/কিভাবে/নিয়ম"…       → অ্যাপ গাইডের সেই অংশ হুবহু
     • সালাম/হাই…                  → শুভেচ্ছা + উদাহরণ
     • বাকি সব                     → পণ্য খোঁজা (না পেলে উদাহরণ দেখায়)
   ===================================================================== */
module.exports = function makeMouFree({ MOU_GUIDE }) {
  const BN = "০১২৩৪৫৬৭৮৯";
  const toEn = (s) => String(s).replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));

  function norm(s) {
    return toEn(String(s || "")).toLowerCase()
      .replace(/[‌‍]/g, "")
      .replace(/[.,!?;:()\[\]{}"'`৷।\-_/\\|+*#@&%$^~<>=?]/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  const has = (t, re) => re.test(t);

  // কথার ফাঁকের শব্দ — খোঁজার সময় বাদ
  const STOP = new Set(("ভাই আপা আপু ভাইয়া মামা চাচা দাদা দিদি বোন প্লিজ please দাও দেন দিন দেবেন দিবেন লাগবে চাই চাইছি দরকার আছে আছেন "
    + "কি কী কোথায় কোথা কই কোন কোনো কত কতো দাম দামে দামের টাকা টাকার টাকায় সস্তা সস্তায় কম বেশি ভালো ভাল সবচেয়ে "
    + "এক দুই তিন চার পাঁচ আধা হাফ কেজি কেজির কেজিতে গ্রাম লিটার পিস টা টি খানা হালি ডজন প্যাকেট বস্তা "
    + "আর ও এবং বা নিচে নীচে মধ্যে ভিতরে উপরে পাবো পাব পাওয়া যাবে যায় পাই কিনবো কিনব কিনতে খুঁজে খুঁজুন খুজে দেখাও দেখান "
    + "বলো বলেন বলুন জানাও জানান একটু একটা আমি আমার আমাকে আপনার তুমি তোমার এই সেই ওই হবে হয় হচ্ছে করে করতে মৌ").split(/\s+/));

  function words(t) {
    return norm(t).split(" ")
      .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d+$/.test(w))
      .slice(0, 4);
  }
  function maxPrice(t) {
    const m = toEn(t).match(/(\d{1,7})\s*(টাকা|tk|৳)?\s*(এর|র)?\s*(নিচে|নীচে|মধ্যে|ভিতরে|কম|under|below)/i);
    return m ? Number(m[1]) : null;
  }
  const cheap = (t) => /সস্তা|কম দাম|কমদাম|সবচেয়ে কম|cheap/.test(t);

  /* 📘 গাইডের একটা অংশ ([... — topic: x] থেকে পরের [ পর্যন্ত) */
  function guideSection(topic) {
    const re = new RegExp("\\[[^\\]]*topic:\\s*" + topic + "\\]([\\s\\S]*?)(?=\\n\\[|$)");
    const m = String(MOU_GUIDE).match(re);
    return m ? m[1].trim() : "";
  }
  function helpTopic(t) {
    if (has(t, /সংগঠন|org|সমিতি|চাঁদা|চাদা|সদস্য/)) return "org";
    if (has(t, /দর্জি|সেলাই|টেইলার|tailor|মাপ/)) return "tailor";
    if (has(t, /রেস্টুরেন্ট|হোটেল|খাবার/)) return "restaurant";
    if (has(t, /ফার্মেসি|ফার্মেসী|ওষুধ|ঔষধ|প্রেসক্রিপশন/)) return "pharmacy";
    if (has(t, /একাদশী|পূজা|পুজা/)) return "ekadashi";
    if (has(t, /messenger|মেসেঞ্জার|চ্যাট|বার্তা|ইউজারনেম/)) return "messenger";
    if (has(t, /ট্রান্সপোর্ট|transport|গাড়ি|গাড়ী|রিকশা|অটো|সিএনজি|ড্রাইভার/)) return "transport";
    if (has(t, /নামাজ|পঞ্জিকা|ঘড়ি|watch/)) return "smartwatch";
    if (has(t, /দোকান খুল|দোকানদার হ|বিক্রেতা|seller|নিবন্ধন|রেজিস্টার/)) return "seller";
    if (has(t, /অর্ডার|কার্ট|cart|কিন|কেনা|ডেলিভারি/)) return "shopping";
    return "general";
  }
  function generalSection() {
    const m = String(MOU_GUIDE).match(/\[সাধারণ[^\]]*\]([\s\S]*?)(?=\n\[|$)/);
    return m ? m[1].trim() : "";
  }

  const EXAMPLES = "যেমন লিখুন:\n• \"আলু\" বা \"সস্তা চাল\"\n• \"৬০০ টাকার নিচে দর্জি\"\n• \"বিরিয়ানি\"\n• \"আমার অর্ডার কোথায়\"\n• \"সংগঠন কীভাবে চলে\"";

  /* → { action } (খুঁজতে হবে) অথবা { reply, topic? } (সরাসরি উত্তর) */
  function route(text) {
    const t = norm(text);
    if (!t) return { reply: "কিছু লিখুন বন্ধু। 🐝\n" + EXAMPLES, mood: "idle" };

    if (/^(আসসালামু|আসসালাম|সালাম|assalam|salam|হাই|হ্যালো|হেলো|hi|hello|নমস্কার|আদাব|শুভ সকাল|শুভ রাত্রি)/.test(t) && t.split(" ").length <= 5) {
      const hello = /সালাম|salam/.test(t) ? "ওয়ালাইকুমুস সালাম!" : "শুভেচ্ছা!";
      return { reply: hello + " আমি মৌ 🐝 — বাজারে জিনিস, দাম, দর্জি, রেস্টুরেন্ট বা আপনার অর্ডার খুঁজে দিতে পারি।\n" + EXAMPLES, mood: "happy" };
    }
    if (/কেমন আছ|কেমন আছেন|how are you/.test(t)) {
      return { reply: "আলহামদুলিল্লাহ, ভালো আছি! 🐝 বাজারে কিছু খুঁজে দেব?\n" + EXAMPLES, mood: "happy" };
    }
    if (/তুমি কে|আপনি কে|তোমার নাম|আপনার নাম|who are you/.test(t)) {
      return { reply: "আমি মৌ 🐝 — Honey Bee Bazar-এর সহকারী। জিনিস, দাম, দর্জি, রেস্টুরেন্ট আর আপনার অর্ডার খুঁজে দিই।\n" + EXAMPLES, mood: "happy" };
    }
    if (/^(ধন্যবাদ|thanks|thank you|থ্যাংকস|শুকরিয়া|জাযাকাল্লাহ)/.test(t)) {
      return { reply: "আপনাকেও ধন্যবাদ! আর কিছু লাগলে জিজ্ঞেস করবেন। 🐝", mood: "happy" };
    }
    if (has(t, /(আমার|my).*(অর্ডার|order|জামা|ডেলিভারি)|(অর্ডার|order).*(কোথায়|কই|কবে|অবস্থা|খবর|status|এসেছে|আসবে)/)) {
      return { action: { type: "my_orders" } };
    }
    if (has(t, /কীভাবে|কিভাবে|কি ভাবে|কী ভাবে|কেমনে|কেমন করে|কি করে|কী করে|নিয়ম|how to|how do|কোথায় পাব.*(অপশন|বোতাম)|লগইন কোথায়/)) {
      const topic = helpTopic(t);
      const sec = topic === "general" ? generalSection() : guideSection(topic);
      if (sec) return { reply: sec.slice(0, 900), topic, mood: "idle", help: true };
    }
    const mp = maxPrice(text);
    if (has(t, /দর্জি|সেলাই|টেইলার|tailor|ব্লাউজ|কামিজ|কামিস|পায়জামা|পাজামা|থ্রি পিস|থ্রিপিস|ফ্রক|পাঞ্জাবি|জামা বানা/)) {
      const cat = has(t, /ব্লাউজ/) ? "blouse" : has(t, /পায়জামা|পাজামা/) ? "pajama" : has(t, /থ্রি পিস|থ্রিপিস|সেট/) ? "set"
        : has(t, /কামিজ|কামিস/) ? "kameez" : has(t, /বাচ্চা|শিশু|ফ্রক/) ? "kids" : null;
      return { action: { type: "find_tailor", words: words(t), category: cat, maxPrice: mp, sort: cheap(t) ? "cheap" : "new" } };
    }
    if (has(t, /রেস্টুরেন্ট|restaurant|হোটেল|খাবার|বিরিয়ানি|বিরানি|কাচ্চি|তেহারি|বার্গার|পিজ্জা|পিৎজা|চাইনিজ|ফুচকা|চটপটি|কাবাব|নাস্তা/)) {
      return { action: { type: "find_restaurant", words: words(t) } };
    }
    const w = words(t);
    if (!w.length) return { reply: "ঠিক বুঝতে পারলাম না। 🐝\n" + EXAMPLES, mood: "idle" };
    return { action: { type: "find_product", words: w, sort: cheap(t) ? "cheap" : null, maxPrice: mp } };
  }

  return { route, EXAMPLES, _test: { norm, words, maxPrice, guideSection, helpTopic } };
};
