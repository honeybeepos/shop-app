/* ==================== 🐝 মৌ — State definitions ====================
   প্রতিটা state-এর জন্য ভ্রু/মুখের SVG path + status-চিপ টেক্সট।
   নতুন state যোগ করতে হলে শুধু এখানে একটা এন্ট্রি যোগ করলেই হবে —
   mou.js-এ কিছু বদলাতে হবে না। */

const MOU_STATES = {
  idle: {
    browL: "M 74 58 Q 82 52 90 57",
    browR: "M 110 57 Q 118 52 126 58",
    mouth: "M 90 94 Q 100 101 110 94",
    chip: "শান্ত আছি 🐝",
  },
  listening: {
    browL: "M 74 54 Q 82 48 90 53",
    browR: "M 110 53 Q 118 48 126 54",
    mouth: "M 94 95 Q 100 99 106 95",
    chip: "শুনছি... 👂",
  },
  happy: {
    browL: "M 74 56 Q 82 48 90 54",
    browR: "M 110 54 Q 118 48 126 56",
    mouth: "M 86 92 Q 100 108 114 92",
    chip: "আনন্দে আছি! 😄",
  },
  serious: {
    browL: "M 74 60 Q 82 56 91 60",
    browR: "M 109 60 Q 118 56 126 60",
    mouth: "M 92 96 L 108 96",
    chip: "মনোযোগ দিচ্ছি 🧐",
  },
};

// 🎯 সাধারণ কথায় ডেমো-রেসপন্স (real AI না — নির্দিষ্ট কিছু কীওয়ার্ড মিলিয়ে)
// প্রতিটা এন্ট্রি একটা state-ও বলে দেয়, যাতে উত্তরের সাথে মৌ-এর expression-ও বদলায়
const MOU_DEMO_RESPONSES = [
  { keywords: ["হ্যালো", "হাই", "hello", "hi"], reply: "হ্যালো বন্ধু! 😊 আমি এখানে আছি।", state: "happy" },
  { keywords: ["ধন্যবাদ", "থ্যাংক"], reply: "স্বাগতম! 🐝 আরও কিছু লাগলে বলবেন।", state: "happy" },
  { keywords: ["কেমন আছ", "কেমন আছো"], reply: "আমি ভালো আছি! আপনার বাজারের কী খবর? 🛒", state: "happy" },
  { keywords: ["সাহায্য", "help"], reply: "চিন্তা নেই, আমি আছি তো! বলুন কী দরকার। 🧐", state: "serious" },
  { keywords: ["বাই", "bye", "বিদায়"], reply: "আবার দেখা হবে বন্ধু! 👋", state: "idle" },
];
const MOU_DEFAULT_REPLY = { reply: "বুঝেছি! এখন আমি শুধু demo mode-এ আছি — শীঘ্রই আরও স্মার্ট হয়ে যাব। 🐝", state: "idle" };
