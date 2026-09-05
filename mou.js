/* ==================== 🐝 মৌ — Interaction Logic (Development #2A) ====================
   ⚠️ শুধু text↔Gemini সংযোগ — Voice/Camera/Memory কিছুই এখানে নেই।
   কোনো conversation history/memory পাঠানো হয় না, প্রতিটা বার্তা
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

async function mouHandleSend(){
  const text = mouTextInput.value.trim();
  if(!text) return;
  mouAppendBubble("user", text);
  mouTextInput.value = "";

  // 🎧 পাঠানোর মুহূর্তে সংক্ষিপ্ত "শুনছি" expression (visual, real listening/mic না)
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
  }catch(e){
    // 🛟 Step 7 — network/permission/অন্য যেকোনো ব্যর্থতায়ও গ্রাহক খালি হাতে থাকেন না
    console.warn("মৌ-চ্যাট কল ব্যর্থ:", e);
    thinkingBubble.remove();
    mouAppendBubble("mou", "দুঃখিত বন্ধু, এই মুহূর্তে আমার সাথে যোগাযোগ করা যাচ্ছে না। একটু পরে চেষ্টা করুন। 🐝");
    mouSetState("idle");
  }

  if(mouReturnTimer) clearTimeout(mouReturnTimer);
  mouReturnTimer = setTimeout(()=> mouSetState("idle"), 3500);
}

mouSendBtn.addEventListener("click", mouHandleSend);
mouTextInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") mouHandleSend(); });

// 🎙️ Voice — এই ধাপেও শুধু placeholder, কোনো mic permission/recording নেই
mouMicBtn.addEventListener("click", ()=>{
  mouMicToast.classList.add("show");
  setTimeout(()=> mouMicToast.classList.remove("show"), 1800);
});

// শুরুতে idle state দিয়ে শুরু (HTML-এও ডিফল্ট বসানো আছে, এখানে আবার নিশ্চিত করা হলো)
mouSetState("idle");
