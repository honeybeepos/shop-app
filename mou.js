/* ==================== 🐝 মৌ — Interaction Logic (Development #3) ====================
   ⚠️ এখন text↔Gemini + real Voice (mic-এ বলা, কণ্ঠে শোনা) — Camera/Memory
   এখনো নেই। কোনো conversation history/memory পাঠানো হয় না, প্রতিটা বার্তা
   স্বতন্ত্রভাবে Cloud Function-এ যায়। */

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

// 🔐 Login না করা visitor-ও মৌ-এর সাথে কথা বলতে পারবেন — কিন্তু Cloud
// Function-টা যেন সম্পূর্ণ open/anonymous script দিয়ে সরাসরি কল করা না
// যায়, তার জন্য অন্তত একটা anonymous Firebase session লাগবে। এটা কোনো
// login-wall না — customer কিছুই টের পান না, ব্যাকগ্রাউন্ডে হয়ে যায়।
mouAuth.onAuthStateChanged((user)=>{
  if(user){ mouAuthReady = true; return; }
  mouAuth.signInAnonymously().then(()=>{ mouAuthReady = true; }).catch((e)=>{
    console.warn("মৌ-এর anonymous session তৈরি ব্যর্থ:", e);
  });
});

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
    // 🧒 বাচ্চাদের জন্য মজার, একটু উঁচু-কণ্ঠের (শিশু-সুলভ) আওয়াজ — pitch বাড়ানো হলো
    // (Web Speech API-তে নির্দিষ্ট "শিশুর কণ্ঠ" বেছে নেওয়ার সুযোগ নেই, তাই pitch দিয়ে
    // যতটা সম্ভব হালকা/কচি শোনানো হচ্ছে — ফোন/ব্রাউজারভেদে ফলাফল কিছুটা আলাদা হতে পারে)
    utter.pitch = 1.35;
    const voices = window.speechSynthesis.getVoices();
    const bnVoices = voices.filter(v=> v.lang === "bn-BD" || v.lang === "bn-IN" || v.lang.startsWith("bn"));
    // মেয়েলি/female voice পাওয়া গেলে সেটাই অগ্রাধিকার — না পেলে male না এমন যেকোনো bn voice, শেষে প্রথমটা
    const bnVoice = bnVoices.find(v=>/female/i.test(v.name))
      || bnVoices.find(v=>!/male/i.test(v.name))
      || bnVoices[0];
    if(bnVoice) utter.voice = bnVoice; // বাংলা voice ইনস্টল করা না থাকলে ব্রাউজারের ডিফল্ট voice-এই বলবে
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

  // 🎧 পাঠানোর মুহূর্তে সংক্ষিপ্ত "শুনছি" expression
  mouSetState("listening");
  await mouWaitForAuth(4000);
  const thinkingBubble = mouShowThinking();

  try{
    const callMouChat = mouFunctions.httpsCallable("mouChat");
    const result = await callMouChat({ text });
    thinkingBubble.remove();
    const reply = (result.data && result.data.reply) || "দুঃখিত বন্ধু, আবার বলবেন? 🐝";
    const mood = (result.data && result.data.mood) || "idle";
    mouAppendBubble("mou", reply);
    mouSetState(mood);
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
