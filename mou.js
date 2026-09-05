/* ==================== 🐝 মৌ — Interaction Logic (Development #1) ====================
   ⚠️ এখানে কোনো real AI/camera/microphone recording/database নেই —
   শুধু demo state-switching ও predefined টেক্সট-রেসপন্স। */

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

// ডেমো-বাটন দিয়ে সরাসরি state বদলানো (টেস্টের জন্য)
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
}

// 🧠 নিয়ম-ভিত্তিক ডেমো-রেসপন্স — কোনো real AI/API কল নেই, শুধু কীওয়ার্ড মিলিয়ে
function mouGetDemoResponse(text){
  const normalized = text.trim().toLowerCase();
  for(const item of MOU_DEMO_RESPONSES){
    if(item.keywords.some((k)=> normalized.includes(k))) return item;
  }
  return MOU_DEFAULT_REPLY;
}

function mouHandleSend(){
  const text = mouTextInput.value.trim();
  if(!text) return;
  mouAppendBubble("user", text);
  mouTextInput.value = "";

  // 🎧 জবাব দেওয়ার আগে সংক্ষিপ্ত "শুনছি" মুহূর্ত — শুধু visual, real listening/mic না
  mouSetState("listening");

  setTimeout(()=>{
    const response = mouGetDemoResponse(text);
    mouAppendBubble("mou", response.reply);
    mouSetState(response.state || "idle");

    // কিছুক্ষণ পর নিজে থেকেই শান্ত (idle) অবস্থায় ফিরে আসা, যদি ইতিমধ্যে idle না হয়ে থাকে
    if(mouReturnTimer) clearTimeout(mouReturnTimer);
    if(response.state !== "idle"){
      mouReturnTimer = setTimeout(()=> mouSetState("idle"), 3000);
    }
  }, 700);
}

mouSendBtn.addEventListener("click", mouHandleSend);
mouTextInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") mouHandleSend(); });

// 🎙️ Voice — এই ধাপে শুধু placeholder, কোনো mic permission/recording নেই
mouMicBtn.addEventListener("click", ()=>{
  mouMicToast.classList.add("show");
  setTimeout(()=> mouMicToast.classList.remove("show"), 1800);
});

// শুরুতে idle state দিয়ে শুরু (HTML-এও ডিফল্ট বসানো আছে, এখানে আবার নিশ্চিত করা হলো)
mouSetState("idle");
