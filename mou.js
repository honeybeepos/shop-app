/* ==================== 🐝 মৌ — Interaction Logic (Development #4) ====================
   ⚠️ text↔Gemini + real Voice (mic-এ বলা, কণ্ঠে শোনা) + আগের কথোপকথন মনে রাখা
   (Firestore মেমোরি) — Camera এখনো নেই।
   মেমোরি কীভাবে কাজ করে: প্রতিটা মেসেজ (কাস্টমারের + মৌ-এর জবাব) Firestore-এ
   mouChats/{uid}/messages সাব-কালেকশনে সেভ হয় (uid — লগইন করা থাকলে আসল uid,
   না করলে anonymous session-এর uid, যেটা ব্রাউজারে persist থাকে)। পেজ খোলার
   সাথে সাথে শেষ কিছু মেসেজ লোড করে চ্যাট বক্সে দেখানো হয়, আর প্রতিটা নতুন
   মেসেজ পাঠানোর সময় সাম্প্রতিক কয়েকটা মেসেজ (history) Cloud Function-এ পাঠানো
   হয় যাতে Gemini আগের কথা মনে রেখে উত্তর দিতে পারে। */

// 🔗 Firebase init — honey-bee-bazar.html-এর ঠিক একই কনফিগ (নতুন প্রজেক্ট না)
const firebaseConfig = {
  apiKey: "AIzaSyD6qmuWkNUrskMIBHq8Z_AQ0N_WT1DL8Is",
  authDomain: "honeybee-984dd.firebaseapp.com",
  projectId: "honeybee-984dd",
  storageBucket: "honeybee-984dd.firebasestorage.app",
  messagingSenderId: "610211112501",
  appId: "1:610211112501:web:9ea40b9060d425e85b737c"
};
firebase.initializeApp(firebaseConfig);
const mouAuth = firebase.auth();
const mouFunctions = firebase.functions();
const mouDb = firebase.firestore();

const mouScreen = document.getElementById("mouScreen");
const mouStateChip = document.getElementById("mouStateChip");
const mouBrowL = document.getElementById("mouBrowL");
const mouBrowR = document.getElementById("mouBrowR");
const mouMouth = document.getElementById("mouMouth");
const mouChatArea = document.getElementById("mouChatArea");
const mouTextInput = document.getElementById("mouTextInput");
const mouSendBtn = document.getElementById("mouSendBtn");
const mouMicBtn = document.getElementById("mouMicBtn");
const mouMicToast = document.getElementById("mouMicToast");
const mouDemoRow = document.getElementById("mouDemoRow");

let mouReturnTimer = null;
let mouAuthReady = false;
let mouUid = null;

// 🧠 চলতি সেশনে এখন পর্যন্ত যা কথা হয়েছে (RAM-এ, Gemini-কে পাঠানোর জন্য) —
// প্রতিটা আইটেম {role:'user'|'mou', text}। পেজ লোড হওয়ার সময় Firestore থেকে
// আগের কথোপকথনও এখানে লোড করে বসানো হয়, যাতে পুরনো সেশনের প্রসঙ্গও মনে থাকে।
let mouHistory = [];
const MOU_HISTORY_LOAD_LIMIT = 20; // পেজ খোলার সময় Firestore থেকে এত মেসেজ পর্যন্ত লোড হবে
const MOU_HISTORY_SEND_LIMIT = 12; // প্রতিবার Gemini-কে এর বেশি পুরনো মেসেজ পাঠানো হয় না (খরচ/সাইজ নিয়ন্ত্রণে)

// 🔐 Login না করা visitor-ও মৌ-এর সাথে কথা বলতে পারবেন — কিন্তু Cloud
// Function-টা যেন সম্পূর্ণ open/anonymous script দিয়ে সরাসরি কল করা না
// যায়, তার জন্য অন্তত একটা anonymous Firebase session লাগবে। এটা কোনো
// login-wall না — customer কিছুই টের পান না, ব্যাকগ্রাউন্ডে হয়ে যায়। এই একই
// uid (anonymous হলেও) দিয়েই Firestore-এ মেমোরি সেভ/লোড হয় — অর্থাৎ একই
// ব্রাউজারে ফিরে এলে মৌ আগের কথা মনে রাখবে, ব্রাউজার/ডিভাইস পাল্টালে না।
mouAuth.onAuthStateChanged((user)=>{
  if(user){ mouAuthReady = true; mouUid = user.uid; mouLoadHistory(); return; }
  mouAuth.signInAnonymously().then((cred)=>{
    mouAuthReady = true;
    mouUid = cred.user.uid;
    mouLoadHistory();
  }).catch((e)=>{
    console.warn("মৌ-এর anonymous session তৈরি ব্যর্থ:", e);
  });
});

// 📖 পেজ খোলার সাথে সাথে Firestore থেকে শেষ কিছু মেসেজ লোড করে চ্যাট বক্সে
// দেখানো — থাকলে ডিফল্ট "হ্যালো" বাবলটা সরিয়ে আসল ইতিহাস দেখানো হয়, একদম
// নতুন কাস্টমার হলে (কোনো ইতিহাস নেই) ডিফল্ট গ্রিটিংটাই থেকে যায়।
function mouLoadHistory(){
  mouDb.collection("mouChats").doc(mouUid).collection("messages")
    .orderBy("createdAt", "desc").limit(MOU_HISTORY_LOAD_LIMIT).get()
    .then((qs)=>{
      if(qs.empty) return;
      const msgs = qs.docs.map(d=> d.data()).reverse();
      mouChatArea.innerHTML = ""; // ডিফল্ট গ্রিটিং বাবল সরানো হলো
      msgs.forEach((m)=>{
        if(m && typeof m.text === "string" && m.text.trim()){
          mouAppendBubble(m.role === "user" ? "user" : "mou", m.text);
          mouHistory.push({ role: m.role === "user" ? "user" : "mou", text: m.text });
        }
      });
    })
    .catch((e)=> console.warn("মৌ-এর পুরনো কথোপকথন লোড করা যায়নি:", e));
}

// 💾 একটা মেসেজ (কাস্টমারের বা মৌ-এর) Firestore-এ সেভ করা — ব্যর্থ হলেও চ্যাট
// থেমে যাবে না (মেমোরি সেভ ব্যর্থ হলে শুধু সেবার মনে রাখা যাবে না, বাকি সব চলবে)
function mouSaveMessage(role, text){
  if(!mouUid) return;
  mouDb.collection("mouChats").doc(mouUid).collection("messages").add({
    role, text, createdAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch((e)=> console.warn("মৌ-এর মেসেজ সেভ ব্যর্থ:", e));
}

// 🎭 মূল state-পরিবর্তন ফাংশন — MOU_STATES (mou-state.js) থেকে ভ্রু/মুখ/চিপ বসায়
function mouSetState(stateName){
  const state = MOU_STATES[stateName];
  if(!state) return;
  mouScreen.dataset.state = stateName;
  mouBrowL.setAttribute("d", state.browL);
  mouBrowR.setAttribute("d", state.browR);
  mouMouth.setAttribute("d", state.mouth);
  mouStateChip.textContent = state.chip;

  mouDemoRow.querySelectorAll(".mouDemoBtn").forEach((btn)=>{
    btn.classList.toggle("active", btn.dataset.state === stateName);
  });
}

// ডেমো-বাটন দিয়ে সরাসরি state বদলানো (এখনো রাখা হয়েছে — expression যাচাই করতে সুবিধাজনক)
mouDemoRow.querySelectorAll(".mouDemoBtn").forEach((btn)=>{
  btn.addEventListener("click", ()=>{
    if(mouReturnTimer) clearTimeout(mouReturnTimer);
    mouSetState(btn.dataset.state);
  });
});

function mouAppendBubble(role, text){
  const bubble = document.createElement("div");
  bubble.className = `mouBubble ${role === "user" ? "user" : "mou"}`;
  bubble.textContent = text;
  mouChatArea.appendChild(bubble);
  mouChatArea.scrollTop = mouChatArea.scrollHeight;
  return bubble;
}

// 🤔 Step 6 — "ভাবছে" bubble — Gemini-এর উত্তর আসার আগে দেখানো হয়, উত্তর
// এলে/ব্যর্থ হলে এটাই সরিয়ে ফেলা হয়
function mouShowThinking(){
  const bubble = document.createElement("div");
  bubble.className = "mouBubble mou mouThinking";
  bubble.innerHTML = `<span></span><span></span><span></span>`;
  mouChatArea.appendChild(bubble);
  mouChatArea.scrollTop = mouChatArea.scrollHeight;
  return bubble;
}

// একবার Firebase Auth রেডি না হলে সর্বোচ্চ কয়েক সেকেন্ড অপেক্ষা করা (পেজ
// খোলার সাথে সাথেই কেউ টাইপ করে ফেললে যাতে ব্যর্থ না হয়)
function mouWaitForAuth(timeoutMs){
  return new Promise((resolve)=>{
    const start = Date.now();
    (function check(){
      if(mouAuthReady || Date.now() - start > timeoutMs) return resolve();
      setTimeout(check, 150);
    })();
  });
}

/* ==================== 🔊 Voice Output — Development #3 ====================
   ব্রাউজার-নেটিভ speechSynthesis — নতুন কোনো API-খরচ নেই। honey-bee-bazar.html-এর
   hbSpeak()-এর সাথে হুবহু একই প্যাটার্ন, যাতে দুই জায়গাতেই একই আচরণ থাকে। */
// 🔇 ইমোজি (যেমন 🐝) TTS ইঞ্জিন মাঝে মাঝে জোরে পড়ে ফেলে (যেমন "মৌমাছি" বলে) —
// চ্যাট বাবলে ইমোজি থাকবে, কিন্তু কণ্ঠে বলার আগে সেগুলো বাদ দেওয়া হয় এখানে
function mouStripEmojiForSpeech(text){
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mouSpeak(text){
  if(!("speechSynthesis" in window)) return;
  const speakText = mouStripEmojiForSpeech(text);
  if(!speakText) return;
  try{
    window.speechSynthesis.cancel(); // মৌ আগের কথা শেষ না করে থাকলে থামিয়ে নতুনটা বলবে
    const utter = new SpeechSynthesisUtterance(speakText);
    utter.lang = "bn-BD";
    utter.rate = 1.05;
    // 🧒 বাচ্চাদের জন্য মজার, উঁচু-কণ্ঠের (মেয়েলি/শিশু-সুলভ) আওয়াজ — pitch আরও বাড়ানো হলো
    // (Web Speech API-তে নির্দিষ্ট "শিশুর কণ্ঠ" বেছে নেওয়ার সুযোগ নেই, আর ফোনভেদে বাংলা voice
    // সাধারণত একটাই থাকে — male/female আলাদা করে বেছে নেওয়া যায় না, তাই pitch-ই একমাত্র লিভার)
    utter.pitch = 1.7;
    const voices = window.speechSynthesis.getVoices();
    const bnVoices = voices.filter(v=> v.lang === "bn-BD" || v.lang === "bn-IN" || v.lang.startsWith("bn"));
    // মেয়েলি/female voice পাওয়া গেলে সেটাই অগ্রাধিকার — না পেলে male না এমন যেকোনো bn voice, শেষে প্রথমটা
    const bnVoice = bnVoices.find(v=>/female/i.test(v.name))
      || bnVoices.find(v=>!/male/i.test(v.name))
      || bnVoices[0];
    if(bnVoice) utter.voice = bnVoice; // বাংলা voice ইনস্টল করা না থাকলে ব্রাউজারের ডিফল্ট voice-এই বলবে
    // 🔍 ডিবাগ — ফোনে ঠিক কোন কোন বাংলা voice আছে সেটা কনসোলে লগ হচ্ছে (ভবিষ্যতে
    // আরও নির্দিষ্টভাবে voice বেছে নিতে হলে এই তথ্য কাজে লাগবে)
    if(bnVoices.length){
      console.log("মৌ-এর জন্য পাওয়া বাংলা voice-গুলো:", bnVoices.map(v=>`${v.name} (${v.lang})`));
    }
    window.speechSynthesis.speak(utter);
  }catch(e){ console.warn("মৌ-এর কথা বলা (speechSynthesis) ব্যর্থ:", e); }
}

function mouShowMicToast(text){
  mouMicToast.textContent = text;
  mouMicToast.classList.add("show");
  setTimeout(()=> mouMicToast.classList.remove("show"), 2200);
}

// 📝 text প্যারামিটার এখন বাধ্যতামূলক — টাইপ করে পাঠানো ও ভয়েসে বলা, দুটো
// পথই একই ফাংশনে মিশে যায়, ইনপুট বক্স থেকে নিজে নিজে পড়ে না
async function mouHandleSend(text){
  if(!text || !text.trim()) return;
  text = text.trim();
  mouAppendBubble("user", text);
  mouTextInput.value = "";

  // 🧠 মেমোরি — এই মেসেজটা পাঠানোর আগেই history-তে আর Firestore-এ যোগ করা
  // হচ্ছে (রেফারেন্সের জন্য কপি), আর Gemini-কে পাঠানোর জন্য সাম্প্রতিক কয়েকটা
  // মেসেজ (এই নতুনটা বাদে, কারণ সেটা আলাদাভাবে `text`-এ যাচ্ছে) কেটে নেওয়া হয়
  const historyForGemini = mouHistory.slice(-MOU_HISTORY_SEND_LIMIT);
  mouHistory.push({ role: "user", text });
  mouSaveMessage("user", text);

  // 🎧 পাঠানোর মুহূর্তে সংক্ষিপ্ত "শুনছি" expression
  mouSetState("listening");
  await mouWaitForAuth(4000);
  const thinkingBubble = mouShowThinking();

  try{
    const callMouChat = mouFunctions.httpsCallable("mouChat");
    const result = await callMouChat({ text, history: historyForGemini });
    thinkingBubble.remove();
    const reply = (result.data && result.data.reply) || "দুঃখিত বন্ধু, আবার বলবেন? 🐝";
    const mood = (result.data && result.data.mood) || "idle";
    mouAppendBubble("mou", reply);
    mouSetState(mood);
    mouHistory.push({ role: "mou", text: reply });
    mouSaveMessage("mou", reply);
    // 🔊 Development #3 — মৌ এখন সত্যিকারের কণ্ঠে জবাব দেয় (টাইপ করে বললেও,
    // ভয়েসে বললেও) — টেক্সট বাবল সবসময়ই থাকে, voice শুধু বাড়তি
    mouSpeak(reply);
  }catch(e){
    // 🛟 Step 7 — network/permission/অন্য যেকোনো ব্যর্থতায়ও গ্রাহক খালি হাতে থাকেন না
    console.warn("মৌ-চ্যাট কল ব্যর্থ:", e);
    thinkingBubble.remove();
    const failReply = "দুঃখিত বন্ধু, এই মুহূর্তে আমার সাথে যোগাযোগ করা যাচ্ছে না। একটু পরে চেষ্টা করুন। 🐝";
    mouAppendBubble("mou", failReply);
    mouSetState("idle");
    mouSpeak(failReply);
    // ⚠️ ব্যর্থতার বার্তাটা ইচ্ছাকৃতভাবে মেমোরিতে/Firestore-এ সেভ করা হচ্ছে না —
    // এটা আসল কথোপকথনের অংশ না, পরের বার আবার জিজ্ঞেস করলে গুলিয়ে যাবে না
  }

  if(mouReturnTimer) clearTimeout(mouReturnTimer);
  mouReturnTimer = setTimeout(()=> mouSetState("idle"), 3500);
}

mouSendBtn.addEventListener("click", ()=> mouHandleSend(mouTextInput.value));
mouTextInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") mouHandleSend(mouTextInput.value); });

/* ==================== 🎙️ Voice Input — Development #3 ====================
   ব্রাউজার-নেটিভ SpeechRecognition — honey-bee-bazar.html-এর hbInitVoiceInput()-এর
   সাথে একই প্যাটার্ন (bn-BD, single-shot)। সাপোর্ট না থাকলে বাটন থাকবে কিন্তু
   ক্লিকে জানিয়ে দেবে, অ্যাপ ভাঙবে না। */
const MOU_SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let mouRecognition = null;
let mouIsListening = false;

function mouInitVoiceInput(){
  if(!MOU_SpeechRecognition){
    mouMicBtn.addEventListener("click", ()=>{
      mouShowMicToast("🎙️ এই ব্রাউজারে ভয়েস সাপোর্ট নেই — টাইপ করে বলুন");
    });
    return;
  }
  mouRecognition = new MOU_SpeechRecognition();
  mouRecognition.lang = "bn-BD";
  mouRecognition.continuous = false;
  mouRecognition.interimResults = false;

  mouRecognition.onstart = ()=>{
    mouIsListening = true;
    mouMicBtn.classList.add("listening");
    mouSetState("listening");
  };
  mouRecognition.onend = ()=>{
    mouIsListening = false;
    mouMicBtn.classList.remove("listening");
  };
  mouRecognition.onerror = (e)=>{
    console.warn("মৌ-এর SpeechRecognition এরর:", e.error);
    mouShowMicToast("🎙️ শুনতে সমস্যা হয়েছে — আবার চেষ্টা করুন বা টাইপ করুন");
    mouSetState("idle");
  };
  mouRecognition.onresult = (e)=>{
    const transcript = e.results[0][0].transcript;
    if(transcript && transcript.trim()) mouHandleSend(transcript);
  };

  mouMicBtn.addEventListener("click", ()=>{
    if(mouIsListening){ mouRecognition.stop(); return; }
    if("speechSynthesis" in window) window.speechSynthesis.cancel(); // মৌ নিজে কথা বলতে থাকলে থামিয়ে আগে শোনা শুরু
    try{ mouRecognition.start(); }
    catch(e){ console.warn("মৌ-এর recognition start ব্যর্থ:", e); }
  });
}
mouInitVoiceInput();

// শুরুতে idle state দিয়ে শুরু (HTML-এও ডিফল্ট বসানো আছে, এখানে আবার নিশ্চিত করা হলো)
mouSetState("idle");
