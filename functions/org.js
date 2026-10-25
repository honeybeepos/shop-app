/* =====================================================================
   🤝🐝 Honey Bee Org — সংগঠন (সার্ভারের সব কাজ)

   একটাই ফোন-থেকে-ডাকা ফাংশন: orgApi({ action, ... })
   + orgTick (প্রতি ৫ মিনিটে: নির্ধারিত পোস্ট প্রকাশ, মেয়াদ শেষ, ভোটের ফলাফল)
   + orgPostLikeCount / orgPostCommentCount (লাইক/মন্তব্য গোনা)

   নিরাপত্তার মূল নিয়ম:
   · ফোন থেকে orgs/… -তে সরাসরি কিছু লেখা যায় না (Firestore rules: write:false)।
     ব্যতিক্রম শুধু লাইক আর মন্তব্য — সেগুলো rules-এ কড়াভাবে বাঁধা।
   · প্রতিটা কাজে transaction-এর ভেতরে যাচাই: কে ডাকছেন, তিনি সক্রিয় সদস্য/অ্যাডমিন কিনা।
   · দুই-অ্যাডমিন নিয়ম: সদস্য গ্রহণ, টাকা জমা নিশ্চিত, সরাসরি খরচ, অ্যাডমিন নিয়োগ,
     সদস্য/অ্যাডমিন বাদ — সবকিছুতে দুইজন আলাদা অ্যাডমিন। একই জন দুবার গোনা হয় না।
     অ্যাডমিন একজন থাকলে (শুরুতে প্রতিষ্ঠাতা) একজনেই হয় — নইলে সংগঠন চালুই হতো না।
   · ভোট গোপন: কে কী ভোট দিলেন শুধু তিনি নিজে দেখেন; সার্ভার শুধু মোট গোনে।
     প্রস্তাব আসার পরে যোগ দেওয়া সদস্য সেই প্রস্তাবে ভোট দিতে পারেন না।
   · টাকার হিসাব মোছা যায় না — বাতিল হলে "বাতিল" হিসেবে থেকে যায়।
   · সব কাজ auditLogs-এ — কে, কখন, কী। কেউ বদলাতে/মুছতে পারেন না।
   ===================================================================== */

module.exports = function makeOrg({ db, FieldValue, Timestamp, onCall, HttpsError, onSchedule, onDocumentWritten, getStorage }) {
  const ORG_MAX_PER_FOUNDER = 3;
  const REAPPLY_AFTER_MS = 24 * 3600000;
  const DELETE_WAIT_MS = 12 * 3600000;
  const POST_IMG_MAX = 100 * 1024;

  /* ---------------- ছোট হেল্পার ---------------- */
  function needUser(request) {
    const a = request.auth;
    if (!a || (a.token.firebase && a.token.firebase.sign_in_provider === "anonymous")) {
      throw new HttpsError("unauthenticated", "আগে Google দিয়ে লগইন করুন");
    }
    return { uid: a.uid, name: String(a.token.name || "সদস্য").slice(0, 60), photo: a.token.picture || null };
  }
  const clean = (v) => String(v == null ? "" : v).replace(/[ \t]+/g, " ").trim();
  function str(v, min, max, label) {
    const s = clean(v);
    if (s.length < min) throw new HttpsError("invalid-argument", `${label} দিন${min > 1 ? ` (কমপক্ষে ${min} অক্ষর)` : ""}`);
    if (s.length > max) throw new HttpsError("invalid-argument", `${label} সর্বোচ্চ ${max} অক্ষর`);
    return s;
  }
  const optStr = (v, max) => clean(v).slice(0, max);
  function phone(v) {
    const d = String(v || "").replace(/[০-৯]/g, (c) => "০১২৩৪৫৬৭৮৯".indexOf(c)).replace(/\D/g, "").replace(/^880/, "0");
    if (!/^01[3-9]\d{8}$/.test(d)) throw new HttpsError("invalid-argument", "সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)");
    return d;
  }
  function id(v, label) {
    const s = String(v || "");
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(s)) throw new HttpsError("invalid-argument", (label || "তথ্য") + " পাওয়া যায়নি");
    return s;
  }
  function money(v) {
    const n = Math.round(Number(v) * 100) / 100;
    if (!isFinite(n) || n <= 0 || n > 100000000) throw new HttpsError("invalid-argument", "টাকার পরিমাণ ঠিক নেই");
    return n;
  }
  const orgRef = (oid) => db.collection("orgs").doc(oid);
  function audit(tx, oid, actor, action, extra) {
    tx.set(orgRef(oid).collection("auditLogs").doc(),
      Object.assign({ action, actorUid: actor.uid, actorName: actor.name, at: FieldValue.serverTimestamp() }, extra || {}));
  }
  function timer(tx, kind, oid, refId, atMs) {
    tx.set(db.collection("orgTimers").doc(`${kind}_${oid}_${refId}`), { kind, orgId: oid, refId, at: Timestamp.fromMillis(atMs) });
  }
  async function getOrg(tx, oid, allowDeleting) {
    const o = await tx.get(orgRef(oid));
    if (!o.exists || o.data().status !== "active") throw new HttpsError("not-found", "সংগঠন পাওয়া যায়নি");
    if (!allowDeleting && o.data().deletion && o.data().deletion.status === "pending") {
      throw new HttpsError("failed-precondition", "সংগঠন মুছে ফেলার অনুরোধ চলছে — আগে সেটা বাতিল করুন");
    }
    return o.data();
  }
  async function member(tx, oid, uid) {
    const m = await tx.get(orgRef(oid).collection("members").doc(uid));
    return (m.exists && m.data().status === "active") ? m.data() : null;
  }
  async function needMember(tx, oid, uid) {
    const m = await member(tx, oid, uid);
    if (!m) throw new HttpsError("permission-denied", "শুধু এই সংগঠনের সদস্যরা এটা করতে পারেন");
    return m;
  }
  async function needAdmin(tx, oid, uid) {
    const m = await member(tx, oid, uid);
    if (!m || m.role !== "admin") throw new HttpsError("permission-denied", "শুধু এই সংগঠনের অ্যাডমিন এটা করতে পারেন");
    return m;
  }
  const need2 = (org) => ((org.adminCount || 1) >= 2 ? 2 : 1);
  function addApproval(doc, me) {
    const by = Array.isArray(doc.approvedBy) ? doc.approvedBy : [];
    if (by.includes(me.uid)) throw new HttpsError("already-exists", "আপনি আগেই অনুমোদন দিয়েছেন — অন্য একজন অ্যাডমিনের অনুমোদন লাগবে");
    return { approvedBy: by.concat(me.uid), approvedNames: (doc.approvedNames || []).concat(me.name) };
  }
  const idx = (uid) => db.collection("orgUserIndex").doc(uid);

  /* =================================================================
     ধাপ ১ — সংগঠন, আবেদন, সদস্য
     ================================================================= */
  async function create(me, d) {
    const name = str(d.name, 3, 60, "সংগঠনের নাম");
    const desc = str(d.desc, 10, 1500, "সংগঠনের পরিচিতি");
    const district = str(d.district, 2, 40, "জেলা");
    const upazila = optStr(d.upazila, 40), area = optStr(d.area, 80);
    const mine = await db.collection("orgs").where("createdBy", "==", me.uid).where("status", "==", "active").get();
    if (mine.size >= ORG_MAX_PER_FOUNDER) throw new HttpsError("resource-exhausted", `একজন সর্বোচ্চ ${ORG_MAX_PER_FOUNDER}টা সংগঠন খুলতে পারেন`);
    const nameLower = name.toLowerCase();
    const dup = await db.collection("orgs").where("district", "==", district).where("nameLower", "==", nameLower).where("status", "==", "active").limit(1).get();
    if (!dup.empty) throw new HttpsError("already-exists", "এই জেলায় একই নামের সংগঠন আগে থেকেই আছে");
    const ref = db.collection("orgs").doc();
    await db.runTransaction(async (tx) => {
      tx.set(ref, {
        name, nameLower, desc, district, upazila, area, createdBy: me.uid, founderName: me.name,
        status: "active", memberCount: 1, adminCount: 1, nextMemberNo: 2,
        fund: { in: 0, out: 0 }, publicFinance: true, quorumPct: 30, thresholdPct: 5,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(ref.collection("members").doc(me.uid), {
        uid: me.uid, name: me.name, photo: me.photo, role: "admin", title: "প্রতিষ্ঠাতা",
        memberNo: 1, status: "active", joinedAt: FieldValue.serverTimestamp(),
      });
      tx.set(idx(me.uid), { orgs: { [ref.id]: { name, role: "admin" } } }, { merge: true });
      audit(tx, ref.id, me, "org_create", { name });
    });
    return { ok: true, orgId: ref.id };
  }

  async function update(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const upd = { updatedAt: FieldValue.serverTimestamp() }, changed = [];
      if (d.name !== undefined) { const n = str(d.name, 3, 60, "সংগঠনের নাম"); if (n !== org.name) { upd.name = n; upd.nameLower = n.toLowerCase(); changed.push("নাম"); } }
      if (d.desc !== undefined) { upd.desc = str(d.desc, 10, 1500, "পরিচিতি"); changed.push("পরিচিতি"); }
      if (d.area !== undefined) { upd.area = optStr(d.area, 80); changed.push("এলাকা"); }
      if (d.upazila !== undefined) { upd.upazila = optStr(d.upazila, 40); }
      if (d.publicFinance !== undefined) { upd.publicFinance = d.publicFinance === true; changed.push("হিসাব প্রকাশ"); }
      if (d.quorumPct !== undefined) { const q = Math.round(Number(d.quorumPct)); if (!(q >= 10 && q <= 100)) throw new HttpsError("invalid-argument", "ন্যূনতম ভোট ১০%–১০০% এর মধ্যে"); upd.quorumPct = q; changed.push("ন্যূনতম ভোট"); }
      tx.update(orgRef(oid), upd);
      audit(tx, oid, me, "org_update", { detail: changed.join(", ") });
      return { ok: true };
    });
  }

  async function apply(me, d) {
    const oid = id(d.orgId, "সংগঠন"), ph = phone(d.phone), note = optStr(d.note, 300);
    const rref = orgRef(oid).collection("requests").doc(me.uid);
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      if (await member(tx, oid, me.uid)) throw new HttpsError("already-exists", "আপনি আগেই এই সংগঠনের সদস্য");
      const old = await tx.get(rref);
      if (old.exists) {
        const o = old.data();
        if (o.status === "pending") throw new HttpsError("already-exists", "আপনার আবেদন আগেই জমা আছে — অনুমোদনের অপেক্ষায়");
        const at = o.decidedAt && o.decidedAt.toMillis ? o.decidedAt.toMillis() : 0;
        if (o.status === "rejected" && Date.now() - at < REAPPLY_AFTER_MS) throw new HttpsError("failed-precondition", "আবেদন বাতিল হয়েছিল — ২৪ ঘণ্টা পর আবার আবেদন করতে পারবেন");
      }
      tx.set(rref, { uid: me.uid, name: me.name, photo: me.photo, phone: ph, note, status: "pending", approvedBy: [], approvedNames: [], createdAt: FieldValue.serverTimestamp() });
      tx.set(idx(me.uid), { applied: { [oid]: { name: org.name } } }, { merge: true });
    });
    return { ok: true };
  }

  async function cancelApply(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const rref = orgRef(oid).collection("requests").doc(me.uid);
    await db.runTransaction(async (tx) => {
      const r = await tx.get(rref);
      if (!r.exists || r.data().status !== "pending") throw new HttpsError("not-found", "অপেক্ষমাণ আবেদন নেই");
      tx.delete(rref);
      tx.set(idx(me.uid), { applied: { [oid]: FieldValue.delete() } }, { merge: true });
    });
    return { ok: true };
  }

  async function decide(me, d) {
    const oid = id(d.orgId, "সংগঠন"), target = id(d.uid, "আবেদন"), approve = d.approve === true;
    const rref = orgRef(oid).collection("requests").doc(target);
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      const r = await tx.get(rref);
      if (!r.exists || r.data().status !== "pending") throw new HttpsError("failed-precondition", "এই আবেদন আর অপেক্ষায় নেই");
      const req = r.data();
      const already = await member(tx, oid, target);
      if (!approve) {
        tx.update(rref, { status: "rejected", rejectedBy: me.uid, rejectedName: me.name, decidedAt: FieldValue.serverTimestamp() });
        tx.set(idx(target), { applied: { [oid]: FieldValue.delete() } }, { merge: true });
        audit(tx, oid, me, "member_reject", { targetUid: target, targetName: req.name });
        return { ok: true, status: "rejected" };
      }
      const ap = addApproval(req, me), needN = need2(org);
      if (ap.approvedBy.length < needN || already) {
        tx.update(rref, ap);
        audit(tx, oid, me, "member_approve_1", { targetUid: target, targetName: req.name });
        return { ok: true, status: "pending", approvals: ap.approvedBy.length, need: needN };
      }
      const no = org.nextMemberNo || 2;
      tx.set(orgRef(oid).collection("members").doc(target), Object.assign({
        uid: target, name: req.name, photo: req.photo || null, phone: req.phone, role: "member", title: "সদস্য",
        memberNo: no, status: "active", joinedAt: FieldValue.serverTimestamp(),
      }, ap));
      tx.update(orgRef(oid), { memberCount: FieldValue.increment(1), nextMemberNo: no + 1, updatedAt: FieldValue.serverTimestamp() });
      tx.update(rref, Object.assign({ status: "approved", decidedAt: FieldValue.serverTimestamp() }, ap));
      tx.set(idx(target), { orgs: { [oid]: { name: org.name, role: "member" } }, applied: { [oid]: FieldValue.delete() } }, { merge: true });
      audit(tx, oid, me, "member_approve", { targetUid: target, targetName: req.name, memberNo: no });
      return { ok: true, status: "approved", memberNo: no };
    });
  }

  async function leave(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      const m = await needMember(tx, oid, me.uid);
      if (org.createdBy === me.uid && (org.memberCount || 1) > 1) {
        throw new HttpsError("failed-precondition", "আপনি প্রতিষ্ঠাতা — সংগঠনে সদস্য থাকা অবস্থায় ছেড়ে যেতে পারবেন না");
      }
      if (m.role === "admin" && (org.adminCount || 1) <= 1 && (org.memberCount || 1) > 1) {
        throw new HttpsError("failed-precondition", "আপনি একমাত্র অ্যাডমিন — আগে আরেকজনকে অ্যাডমিন করুন, তারপর ছাড়তে পারবেন");
      }
      tx.update(orgRef(oid).collection("members").doc(me.uid), { status: "left", leftAt: FieldValue.serverTimestamp() });
      const upd = { memberCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() };
      if (m.role === "admin") upd.adminCount = FieldValue.increment(-1);
      tx.update(orgRef(oid), upd);
      tx.set(idx(me.uid), { orgs: { [oid]: FieldValue.delete() } }, { merge: true });
      audit(tx, oid, me, "member_leave", {});
    });
    return { ok: true };
  }

  /* =================================================================
     ধাপ ২ — পোস্ট (অ্যাডমিন লেখেন; পাবলিক / শুধু সদস্য; নির্ধারিত সময়ে প্রকাশ; মেয়াদ)
     ================================================================= */
  async function postCreate(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const text = str(d.text, 1, 3000, "পোস্টের লেখা");
    const audience = d.audience === "public" ? "public" : "members";
    const now = Date.now();
    let publishAt = Number(d.publishAt) || 0;
    if (publishAt && (publishAt < now - 60000 || publishAt > now + 60 * 86400000)) throw new HttpsError("invalid-argument", "প্রকাশের সময় ৬০ দিনের মধ্যে দিন");
    if (!publishAt || publishAt < now) publishAt = now;
    let expireAt = Number(d.expireAt) || 0;
    if (expireAt && (expireAt <= publishAt + 10 * 60000 || expireAt > publishAt + 366 * 86400000)) throw new HttpsError("invalid-argument", "মেয়াদ প্রকাশের পর ১০ মিনিট থেকে ১ বছরের মধ্যে দিন");
    let imagePath = null;
    if (d.imagePath) {
      imagePath = String(d.imagePath);
      const prefix = `orgPosts/${oid}/${audience}/${me.uid}/`;
      if (!imagePath.startsWith(prefix) || !/^[A-Za-z0-9_\-/.]+$/.test(imagePath) || imagePath.includes("..")) throw new HttpsError("invalid-argument", "ছবি ঠিক নেই — আবার দিন");
      const [meta] = await getStorage().bucket().file(imagePath).getMetadata().catch(() => [null]);
      if (!meta || Number(meta.size) > POST_IMG_MAX || meta.contentType !== "image/webp") throw new HttpsError("invalid-argument", "ছবি পাওয়া যায়নি বা ১০০ KB-এর বেশি");
    }
    const ref = orgRef(oid).collection("posts").doc();
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      const mm = await needMember(tx, oid, me.uid); // ✍️ সদস্যরাও পোস্ট দিতে পারেন (অক্টোবর ২০২৬)
      if (imagePath && mm.role !== "admin") throw new HttpsError("permission-denied", "পোস্টে ছবি শুধু অ্যাডমিন দিতে পারেন");
      tx.set(ref, {
        authorUid: me.uid, authorName: me.name, authorRole: mm.role, orgName: org.name, text, audience, imagePath,
        status: publishAt > now + 30000 ? "scheduled" : "published",
        publishAt: Timestamp.fromMillis(publishAt), expireAt: expireAt ? Timestamp.fromMillis(expireAt) : null,
        likeCount: 0, commentCount: 0, createdAt: FieldValue.serverTimestamp(),
      });
      if (publishAt > now + 30000) timer(tx, "post_publish", oid, ref.id, publishAt);
      if (expireAt) timer(tx, "post_expire", oid, ref.id, expireAt);
      audit(tx, oid, me, "post_create", { postId: ref.id, detail: audience === "public" ? "পাবলিক" : "শুধু সদস্য" });
    });
    return { ok: true, postId: ref.id };
  }

  /* ✏️ পোস্ট এডিট — লেখা আর মেয়াদ বদলানো যায় (অ্যাডমিন)। কারা দেখবেন বা ছবি বদলানো যায় না —
     ছবি পাবলিক/সদস্য আলাদা ফোল্ডারে থাকে, বদলালে ভুল লোক ছবি দেখে ফেলত; দরকার হলে নতুন পোস্ট দিন। */
  async function postEdit(me, d) {
    const oid = id(d.orgId, "সংগঠন"), pid = id(d.postId, "পোস্ট");
    const text = str(d.text, 1, 3000, "পোস্টের লেখা");
    let expireAt = d.expireAt === null || d.expireAt === 0 ? 0 : Number(d.expireAt) || 0;
    await db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      const mm = await needMember(tx, oid, me.uid);
      const ps = await tx.get(orgRef(oid).collection("posts").doc(pid));
      if (!ps.exists || ps.data().status === "removed") throw new HttpsError("not-found", "পোস্ট পাওয়া যায়নি");
      // ✏️ অ্যাডমিন যেকোনো পোস্ট, সাধারণ সদস্য শুধু নিজের পোস্ট এডিট করতে পারেন
      if (mm.role !== "admin" && ps.data().authorUid !== me.uid) throw new HttpsError("permission-denied", "শুধু নিজের পোস্ট এডিট করা যায়");
      const p = ps.data();
      const base = Math.max(Date.now(), p.publishAt ? p.publishAt.toMillis() : 0);
      const same = expireAt && p.expireAt && p.expireAt.toMillis() === expireAt;
      if (expireAt && !same && (expireAt <= base + 10 * 60000 || expireAt > base + 366 * 86400000)) throw new HttpsError("invalid-argument", "মেয়াদ এখন থেকে ১০ মিনিট থেকে ১ বছরের মধ্যে দিন");
      const upd = { text, editedAt: FieldValue.serverTimestamp(), editedBy: me.name, expireAt: expireAt ? Timestamp.fromMillis(expireAt) : null };
      if (p.status === "expired" && (!expireAt || expireAt > Date.now())) upd.status = "published"; // মেয়াদ বাড়ালে আবার দেখা যাবে
      tx.update(ps.ref, upd);
      const tref = db.collection("orgTimers").doc(`post_expire_${oid}_${pid}`);
      if (expireAt) timer(tx, "post_expire", oid, pid, expireAt); else tx.delete(tref);
      audit(tx, oid, me, "post_edit", { postId: pid, detail: text.slice(0, 60) });
    });
    return { ok: true };
  }

  async function postRemove(me, d) {
    const oid = id(d.orgId, "সংগঠন"), pid = id(d.postId, "পোস্ট");
    let img = null;
    await db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      const mm = await needMember(tx, oid, me.uid);
      const p = await tx.get(orgRef(oid).collection("posts").doc(pid));
      if (!p.exists || p.data().status === "removed") throw new HttpsError("not-found", "পোস্ট পাওয়া যায়নি");
      // 🗑️ অ্যাডমিন যেকোনো পোস্ট, সাধারণ সদস্য শুধু নিজের পোস্ট সরাতে পারেন
      if (mm.role !== "admin" && p.data().authorUid !== me.uid) throw new HttpsError("permission-denied", "শুধু নিজের পোস্ট সরানো যায়");
      img = p.data().imagePath;
      tx.update(p.ref, { status: "removed", removedBy: me.uid, removedAt: FieldValue.serverTimestamp(), imagePath: null });
      audit(tx, oid, me, "post_remove", { postId: pid, detail: String(p.data().text || "").slice(0, 60) });
    });
    if (img) await getStorage().bucket().file(img).delete().catch(() => {});
    return { ok: true };
  }

  /* =================================================================
     ধাপ ৩ — টাকার হিসাব
     জমা: একজন অ্যাডমিন লেখেন → আরেকজন নিশ্চিত করলে হিসাবে ওঠে
     সরাসরি খরচ: দুইজন অ্যাডমিন (বড় খরচ প্রস্তাব-ভোটে — ধাপ ৪)
     সদস্যের চাঁদা হলে dues-এ আলাদা লেখা — শুধু সেই সদস্য আর অ্যাডমিনরা দেখেন
     ================================================================= */
  const METHODS = ["বিকাশ", "নগদ", "রকেট", "হাতে নগদ", "ব্যাংক ট্রান্সফার", "অন্যান্য"];
  function countTx(tx, oid, org, t, txRef) {
    const inc = {};
    inc[t.type === "in" ? "fund.in" : "fund.out"] = FieldValue.increment(t.amount);
    inc.updatedAt = FieldValue.serverTimestamp();
    tx.update(orgRef(oid), inc);
    if (t.aidId && t.type === "in") tx.update(orgRef(oid).collection("aid").doc(t.aidId), { raised: FieldValue.increment(t.amount) });
    if (t.duesId) tx.update(orgRef(oid).collection("dues").doc(t.duesId), { status: "verified" });
    return { public: org.publicFinance !== false, counted: true };
  }
  async function txCreate(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const type = d.type === "out" ? "out" : "in";
    const title = str(d.title, 2, 80, type === "in" ? "টাকার উৎস" : "খরচের খাত");
    const amount = money(d.amount);
    const method = METHODS.includes(d.method) ? d.method : "অন্যান্য";
    const reference = optStr(d.reference, 60), note = optStr(d.note, 300);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || "")) ? String(d.date) : new Date().toISOString().slice(0, 10);
    const memberUid = type === "in" && d.memberUid ? id(d.memberUid, "সদস্য") : null;
    // 📥 সদস্য বাইরে থেকে টাকা তুলে অ্যাডমিনকে দিলে — কে তুলেছেন সেটা লেখা থাকে (চাঁদা না, অনুদান)
    const collectorUid = type === "in" && !memberUid && d.collectorUid ? id(d.collectorUid, "সদস্য") : null;
    const aidId = type === "in" && d.aidId ? id(d.aidId, "সেবা") : null;
    const ref = orgRef(oid).collection("transactions").doc();
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      let mem = null, aid = null;
      if (memberUid) { mem = await member(tx, oid, memberUid); if (!mem) throw new HttpsError("not-found", "এই সদস্য পাওয়া যায়নি"); }
      let col = null;
      if (collectorUid) { col = await member(tx, oid, collectorUid); if (!col) throw new HttpsError("not-found", "এই সদস্য পাওয়া যায়নি"); }
      if (aidId) { aid = await tx.get(orgRef(oid).collection("aid").doc(aidId)); if (!aid.exists) throw new HttpsError("not-found", "মানবিক সেবা পাওয়া যায়নি"); }
      const one = need2(org) === 1;
      const t = {
        type, title: memberUid ? "সদস্য চাঁদা" : (col ? "বাহিরের অনুদান — " + title : title), amount, method, reference, note, date,
        collectorUid: col ? collectorUid : null, collectorName: col ? col.name : null,
        aidId, aidTitle: aid ? aid.data().title : null, createdBy: me.uid, createdByName: me.name,
        approvedBy: [me.uid], approvedNames: [me.name],
        status: one ? (type === "in" ? "verified" : "approved") : "pending", public: false, counted: false,
        createdAt: FieldValue.serverTimestamp(),
      };
      if (memberUid) {
        const dref = orgRef(oid).collection("dues").doc();
        t.duesId = dref.id;
        tx.set(dref, { memberUid, memberName: mem.name, amount, date, method, txId: ref.id, status: one ? "verified" : "pending", note: title, createdAt: FieldValue.serverTimestamp() });
      }
      if (one) Object.assign(t, countTx(tx, oid, org, Object.assign({}, t, { duesId: null }), ref)); // চাঁদার নথি উপরে আগেই "যাচাইকৃত" লেখা
      tx.set(ref, t);
      audit(tx, oid, me, type === "in" ? "money_in" : "money_out", { amount, detail: t.title + (mem ? " — " + mem.name : "") + (col ? " (তুলেছেন: " + col.name + ")" : ""), targetUid: (mem || col) ? (memberUid || collectorUid) : null, targetName: mem ? mem.name : col ? col.name : null });
      return { ok: true, status: t.status };
    });
  }
  async function txDecide(me, d) {
    const oid = id(d.orgId, "সংগঠন"), tid = id(d.txId, "লেনদেন"), approve = d.approve === true;
    const ref = orgRef(oid).collection("transactions").doc(tid);
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const s = await tx.get(ref);
      if (!s.exists || s.data().status !== "pending") throw new HttpsError("failed-precondition", "এই লেনদেন আর অপেক্ষায় নেই");
      const t = s.data();
      if (!approve) {
        tx.update(ref, { status: "rejected", rejectedBy: me.uid, rejectedName: me.name, decidedAt: FieldValue.serverTimestamp() });
        if (t.duesId) tx.update(orgRef(oid).collection("dues").doc(t.duesId), { status: "rejected" });
        audit(tx, oid, me, "money_reject", { amount: t.amount, detail: t.title });
        return { ok: true, status: "rejected" };
      }
      const ap = addApproval(t, me);
      if (ap.approvedBy.length < need2(org)) { tx.update(ref, ap); return { ok: true, status: "pending" }; }
      const st = t.type === "in" ? "verified" : "approved";
      const extra = countTx(tx, oid, org, t, ref);
      tx.update(ref, Object.assign({ status: st, decidedAt: FieldValue.serverTimestamp() }, ap, extra));
      audit(tx, oid, me, t.type === "in" ? "money_in_ok" : "money_out_ok", { amount: t.amount, detail: t.title });
      return { ok: true, status: st };
    });
  }

  /* =================================================================
     ধাপ ৪ — খরচের প্রস্তাব ও ভোট
     পাস: মোট ভোট ≥ ন্যূনতম % সদস্য, আর "হ্যাঁ" > "না" × (১ + ব্যবধান%)
     পাস হলে খরচটা নিজে থেকেই হিসাবে ওঠে (ভোটই অনুমোদন)
     ================================================================= */
  async function proposalCreate(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const title = str(d.title, 5, 120, "প্রস্তাবের শিরোনাম");
    const reason = str(d.reason, 10, 2000, "কারণ");
    const amount = money(d.amount);
    const category = optStr(d.category, 60) || "অন্যান্য";
    const evidence = optStr(d.evidence, 500);
    const hours = [24, 48, 72].includes(Number(d.hours)) ? Number(d.hours) : 24;
    const now = Date.now();
    let startAt = Number(d.startAt) || now;
    if (startAt < now - 60000 || startAt > now + 7 * 86400000) throw new HttpsError("invalid-argument", "ভোট শুরুর সময় ৭ দিনের মধ্যে দিন");
    if (startAt < now) startAt = now;
    const endAt = startAt + hours * 3600000;
    const ref = orgRef(oid).collection("proposals").doc();
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      const thresholdPct = Math.max(1, Math.min(100, Math.round(Number(d.thresholdPct) || org.thresholdPct || 5)));
      tx.set(ref, {
        title, reason, amount, category, evidence, createdBy: me.uid, createdByName: me.name,
        startAt: Timestamp.fromMillis(startAt), endAt: Timestamp.fromMillis(endAt), hours,
        thresholdPct, quorumPct: org.quorumPct || 30, eligible: org.memberCount || 1,
        yes: 0, no: 0, status: "open", commentCount: 0, createdAt: FieldValue.serverTimestamp(),
      });
      timer(tx, "proposal_close", oid, ref.id, endAt);
      audit(tx, oid, me, "proposal_create", { amount, detail: title });
    });
    return { ok: true, proposalId: ref.id };
  }
  async function proposalCancel(me, d) {
    const oid = id(d.orgId, "সংগঠন"), pid = id(d.proposalId, "প্রস্তাব");
    await db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const p = await tx.get(orgRef(oid).collection("proposals").doc(pid));
      if (!p.exists || p.data().status !== "open") throw new HttpsError("failed-precondition", "প্রস্তাব আর খোলা নেই");
      if (p.data().startAt.toMillis() <= Date.now()) throw new HttpsError("failed-precondition", "ভোট শুরু হয়ে গেছে — এখন আর বাতিল করা যাবে না");
      tx.update(p.ref, { status: "cancelled", cancelledBy: me.name, decidedAt: FieldValue.serverTimestamp() });
      tx.delete(db.collection("orgTimers").doc(`proposal_close_${oid}_${pid}`));
      audit(tx, oid, me, "proposal_cancel", { detail: p.data().title });
    });
    return { ok: true };
  }
  async function vote(me, d) {
    const oid = id(d.orgId, "সংগঠন"), pid = id(d.proposalId, "প্রস্তাব");
    const choice = d.choice === "yes" ? "yes" : d.choice === "no" ? "no" : null;
    if (!choice) throw new HttpsError("invalid-argument", "হ্যাঁ বা না বাছুন");
    const pref = orgRef(oid).collection("proposals").doc(pid), vref = pref.collection("votes").doc(me.uid);
    return db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      const m = await needMember(tx, oid, me.uid);
      const ps = await tx.get(pref);
      if (!ps.exists || ps.data().status !== "open") throw new HttpsError("failed-precondition", "এই ভোট আর খোলা নেই");
      const p = ps.data(), now = Date.now();
      if (now < p.startAt.toMillis()) throw new HttpsError("failed-precondition", "ভোট এখনো শুরু হয়নি");
      if (now >= p.endAt.toMillis()) throw new HttpsError("failed-precondition", "ভোটের সময় শেষ");
      const joined = m.joinedAt && m.joinedAt.toMillis ? m.joinedAt.toMillis() : 0;
      const created = p.createdAt && p.createdAt.toMillis ? p.createdAt.toMillis() : 0;
      if (joined > created) throw new HttpsError("permission-denied", "এই প্রস্তাব আসার পরে যোগ দিয়েছেন — এতে ভোট দিতে পারবেন না");
      const v = await tx.get(vref);
      const old = v.exists ? v.data().choice : null;
      if (old === choice) return { ok: true, same: true };
      const upd = {};
      upd[choice] = FieldValue.increment(1);
      if (old) upd[old] = FieldValue.increment(-1);
      tx.update(pref, upd);
      tx.set(vref, { choice, at: FieldValue.serverTimestamp() });
      return { ok: true, choice };
    });
  }
  async function closeProposal(oid, pid) {
    await db.runTransaction(async (tx) => {
      const oref = orgRef(oid);
      const os = await tx.get(oref);
      const ps = await tx.get(oref.collection("proposals").doc(pid));
      if (!os.exists || !ps.exists || ps.data().status !== "open") return;
      const p = ps.data(), org = os.data();
      if (p.endAt.toMillis() > Date.now()) return;
      const total = (p.yes || 0) + (p.no || 0);
      const needVotes = Math.ceil((p.eligible || 1) * (p.quorumPct || 30) / 100);
      const quorumOk = total >= needVotes;
      const passed = quorumOk && (p.yes || 0) > 0 && (p.yes || 0) > (p.no || 0) * (1 + (p.thresholdPct || 5) / 100);
      const upd = { status: passed ? "approved" : "rejected", decidedAt: FieldValue.serverTimestamp(), quorumOk, needVotes };
      const sys = { uid: "system", name: "ভোটের ফলাফল" };
      if (passed && org.status === "active") {
        const tref = oref.collection("transactions").doc();
        const t = {
          type: "out", title: p.title, amount: p.amount, method: "অন্যান্য", reference: "প্রস্তাব PR-" + pid.slice(-5).toUpperCase(),
          note: "ভোটে পাস — হ্যাঁ " + p.yes + ", না " + p.no, date: new Date().toISOString().slice(0, 10),
          proposalId: pid, createdBy: "system", createdByName: "ভোটে অনুমোদিত", approvedBy: [], approvedNames: [],
          status: "approved", createdAt: FieldValue.serverTimestamp(),
        };
        Object.assign(t, countTx(tx, oid, org, t, tref));
        tx.set(tref, t);
        upd.txId = tref.id;
      }
      tx.update(ps.ref, upd);
      audit(tx, oid, sys, passed ? "proposal_pass" : "proposal_fail", { amount: p.amount, detail: `${p.title} — হ্যাঁ ${p.yes}, না ${p.no}${quorumOk ? "" : " (যথেষ্ট ভোট পড়েনি)"}` });
    });
  }

  /* =================================================================
     ধাপ ৫ — মানবিক সেবা, পদবি, অ্যাডমিন নিয়োগ/বাদ, সদস্য বাদ, সংগঠন মোছা
     ================================================================= */
  async function aidSave(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const title = str(d.title, 3, 100, "সেবার নাম"), desc = optStr(d.desc, 1500);
    const target = money(d.target);
    const status = d.status === "done" ? "done" : "running";
    const isPublic = d.public !== false;
    return db.runTransaction(async (tx) => {
      await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      let ref;
      if (d.aidId) {
        ref = orgRef(oid).collection("aid").doc(id(d.aidId, "সেবা"));
        const s = await tx.get(ref);
        if (!s.exists) throw new HttpsError("not-found", "সেবা পাওয়া যায়নি");
        tx.update(ref, { title, desc, target, status, public: isPublic, updatedAt: FieldValue.serverTimestamp() });
      } else {
        ref = orgRef(oid).collection("aid").doc();
        tx.set(ref, { title, desc, target, raised: 0, status, public: isPublic, createdBy: me.name, createdAt: FieldValue.serverTimestamp() });
      }
      audit(tx, oid, me, d.aidId ? "aid_update" : "aid_create", { amount: target, detail: title });
      return { ok: true, aidId: ref.id };
    });
  }
  async function setTitle(me, d) {
    const oid = id(d.orgId, "সংগঠন"), target = id(d.uid, "সদস্য");
    const title = str(d.title, 2, 40, "পদবি");
    await db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const m = await member(tx, oid, target);
      if (!m) throw new HttpsError("not-found", "সদস্য পাওয়া যায়নি");
      tx.update(orgRef(oid).collection("members").doc(target), { title });
      audit(tx, oid, me, "set_title", { targetUid: target, targetName: m.name, detail: title });
    });
    return { ok: true };
  }
  /* অ্যাডমিন বানানো / অ্যাডমিন সরানো / সদস্য বাদ — প্রস্তাব + অনুমোদন।
     যাঁকে নিয়ে কাজ, তিনি নিজে অনুমোদন দিতে পারেন না। অনুমোদন লাগে:
     যত অ্যাডমিন আছেন (তিনি বাদে) তার মধ্যে ২ জন — একজন থাকলে একজন। */
  const ACTIONS = { make_admin: "অ্যাডমিন বানানো", remove_admin: "অ্যাডমিন থেকে সরানো", remove_member: "সদস্যপদ বাতিল", resign_admin: "অ্যাডমিন পদ থেকে পদত্যাগ" };
  /* 🙋 পদত্যাগের আবেদন — অ্যাডমিন নিজে আবেদন করেন, অন্য অ্যাডমিনরা অনুমতি দেন
     (অন্য অ্যাডমিন ২+ হলে দুইজন, একজন হলে একজন)। একমাত্র অ্যাডমিন পারেন না —
     তাহলে সংগঠন অ্যাডমিন ছাড়া পড়ে থাকত। অনুমতির আগে আবেদন তুলে নেওয়া যায়। */
  async function resignRequest(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const reason = optStr(d.reason, 300);
    const aref = orgRef(oid).collection("adminActions").doc(`resign_admin_${me.uid}`);
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      const m = await needAdmin(tx, oid, me.uid);
      const others = (org.adminCount || 1) - 1;
      if (others < 1) throw new HttpsError("failed-precondition", "আপনি একমাত্র অ্যাডমিন — আগে আরেকজনকে অ্যাডমিন বানান, তারপর পদত্যাগ করতে পারবেন");
      const s = await tx.get(aref);
      if (s.exists && s.data().status === "pending") throw new HttpsError("already-exists", "আপনার পদত্যাগের আবেদন আগেই জমা আছে");
      tx.set(aref, { kind: "resign_admin", targetUid: me.uid, targetName: m.name, reason, status: "pending", need: Math.min(2, others), approvedBy: [], approvedNames: [], createdAt: FieldValue.serverTimestamp() });
      audit(tx, oid, me, "resign_request", { detail: reason });
      return { ok: true, need: Math.min(2, others) };
    });
  }
  async function resignCancel(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const aref = orgRef(oid).collection("adminActions").doc(`resign_admin_${me.uid}`);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(aref);
      if (!s.exists || s.data().status !== "pending") throw new HttpsError("not-found", "অপেক্ষমাণ আবেদন নেই");
      tx.update(aref, { status: "withdrawn", decidedAt: FieldValue.serverTimestamp() });
      audit(tx, oid, me, "resign_cancel", {});
    });
    return { ok: true };
  }
  async function adminAction(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const kind = Object.keys(ACTIONS).includes(d.kind) ? d.kind : null;
    if (!kind) throw new HttpsError("invalid-argument", "কাজ ঠিক নেই");
    const target = id(d.uid, "সদস্য");
    if (target === me.uid) throw new HttpsError("failed-precondition", "নিজের জন্য এটা করা যাবে না");
    const aref = orgRef(oid).collection("adminActions").doc(`${kind}_${target}`);
    const approve = d.approve !== false;
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      const t = await member(tx, oid, target);
      if (!t) throw new HttpsError("not-found", "সদস্য পাওয়া যায়নি");
      // 🛡️ প্রতিষ্ঠাতাকে কেউ সরাতে পারেন না — তিনি নিজে চাইলে শুধু পদত্যাগের আবেদন
      if (target === org.createdBy && (kind === "remove_admin" || kind === "remove_member")) throw new HttpsError("permission-denied", "প্রতিষ্ঠাতাকে সরানো যায় না");
      if (kind === "make_admin" && t.role === "admin") throw new HttpsError("already-exists", "ইনি আগেই অ্যাডমিন");
      if (kind === "resign_admin" && t.role !== "admin") throw new HttpsError("failed-precondition", "ইনি আর অ্যাডমিন নন");
      if (kind === "remove_admin" && t.role !== "admin") throw new HttpsError("failed-precondition", "ইনি অ্যাডমিন নন");
      const othersAdmins = (org.adminCount || 1) - (t.role === "admin" ? 1 : 0);
      if (othersAdmins < 1) throw new HttpsError("failed-precondition", "এটা করার মতো অন্য অ্যাডমিন নেই");
      if ((kind === "remove_admin" || kind === "remove_member") && t.role === "admin" && othersAdmins < 2) {
        throw new HttpsError("failed-precondition", "একজন অ্যাডমিনকে সরাতে আরও দুইজন অ্যাডমিন লাগবে — এখন সেটা সম্ভব না");
      }
      const needN = Math.min(2, othersAdmins);
      const s = await tx.get(aref);
      const cur = (s.exists && s.data().status === "pending") ? s.data() : null;
      if (kind === "resign_admin" && !cur) throw new HttpsError("not-found", "পদত্যাগের আবেদন পাওয়া যায়নি");
      if (!approve) {
        if (!cur) throw new HttpsError("not-found", "অপেক্ষমাণ প্রস্তাব নেই");
        tx.update(aref, { status: "rejected", rejectedBy: me.name, decidedAt: FieldValue.serverTimestamp() });
        audit(tx, oid, me, "action_reject", { targetUid: target, targetName: t.name, detail: ACTIONS[kind] });
        return { ok: true, status: "rejected" };
      }
      const ap = addApproval(cur || {}, me);
      if (ap.approvedBy.length < needN) {
        tx.set(aref, Object.assign({}, cur || {}, { kind, targetUid: target, targetName: t.name, status: "pending", need: needN, createdAt: cur ? cur.createdAt : FieldValue.serverTimestamp() }, ap));
        audit(tx, oid, me, "action_propose", { targetUid: target, targetName: t.name, detail: ACTIONS[kind] });
        return { ok: true, status: "pending", approvals: ap.approvedBy.length, need: needN };
      }
      const mref = orgRef(oid).collection("members").doc(target);
      const oupd = { updatedAt: FieldValue.serverTimestamp() };
      if (kind === "make_admin") {
        tx.update(mref, { role: "admin", title: t.title === "সদস্য" ? "অ্যাডমিন" : t.title });
        oupd.adminCount = FieldValue.increment(1);
        tx.set(idx(target), { orgs: { [oid]: { name: org.name, role: "admin" } } }, { merge: true });
      } else if (kind === "remove_admin" || kind === "resign_admin") {
        tx.update(mref, { role: "member", title: target === org.createdBy ? "প্রতিষ্ঠাতা" : "সদস্য" });
        oupd.adminCount = FieldValue.increment(-1);
        tx.set(idx(target), { orgs: { [oid]: { name: org.name, role: "member" } } }, { merge: true });
      } else {
        tx.update(mref, { status: "removed", removedAt: FieldValue.serverTimestamp() });
        oupd.memberCount = FieldValue.increment(-1);
        if (t.role === "admin") oupd.adminCount = FieldValue.increment(-1);
        tx.set(idx(target), { orgs: { [oid]: FieldValue.delete() } }, { merge: true });
      }
      tx.update(orgRef(oid), oupd);
      tx.set(aref, Object.assign({}, cur || {}, { kind, targetUid: target, targetName: t.name, status: "done", need: needN, decidedAt: FieldValue.serverTimestamp() }, ap));
      audit(tx, oid, me, "action_done", { targetUid: target, targetName: t.name, detail: ACTIONS[kind] });
      return { ok: true, status: "done" };
    });
  }
  async function deleteRequest(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      if (org.deletion && org.deletion.status === "pending") throw new HttpsError("already-exists", "মুছে ফেলার অনুরোধ আগেই চলছে");
      tx.update(orgRef(oid), { deletion: { status: "pending", by: me.uid, byName: me.name, at: Timestamp.now(), deadline: Timestamp.fromMillis(Date.now() + DELETE_WAIT_MS) } });
      audit(tx, oid, me, "delete_request", {});
    });
    return { ok: true };
  }
  async function deleteCancel(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      if (!org.deletion || org.deletion.status !== "pending") throw new HttpsError("not-found", "কোনো অনুরোধ চলছে না");
      tx.update(orgRef(oid), { deletion: { status: "cancelled", cancelledBy: me.name, at: Timestamp.now() } });
      audit(tx, oid, me, "delete_cancel", {});
    });
    return { ok: true };
  }
  async function deleteFinalize(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const del = org.deletion;
      if (!del || del.status !== "pending") throw new HttpsError("failed-precondition", "আগে মুছে ফেলার অনুরোধ করুন");
      if (del.deadline.toMillis() > Date.now()) throw new HttpsError("failed-precondition", "১২ ঘণ্টা এখনো পূর্ণ হয়নি");
      // 🗄️ টাকার হিসাব আর কাজের খাতা থেকে যায় — শুধু সংগঠন বন্ধ হয়ে সবার কাছ থেকে লুকিয়ে যায়
      tx.update(orgRef(oid), { status: "deleted", deletedBy: me.uid, deletedAt: FieldValue.serverTimestamp(), deletion: Object.assign({}, del, { status: "done" }) });
      audit(tx, oid, me, "org_delete", {});
    });
    return { ok: true };
  }


  /* =================================================================
     🗳️ নির্বাচন — পদের জন্য (সভাপতি, সম্পাদক…)। জয়ী পদবি পান, অ্যাডমিনের ক্ষমতা না —
     ক্ষমতা দেন শুধু অ্যাডমিনরা (মালিকের নিয়ম: "কেউ চাইলে অ্যাডমিন হতে পারবে না")।
     ধাপ: খসড়া (লুকানো) → প্রকাশ (দুই-অ্যাডমিন) → প্রার্থী আবেদন → আবেদন বন্ধ →
     কাউন্টডাউন → ভোট (গোপন, একবার) → ফলাফল → জয়ীর পদবি।
     · ভোটার ও প্রার্থী: নির্বাচন প্রকাশের আগে যাঁরা সদস্য — পরে ঢুকে ভোট জেতা যায় না
     · মোট ভোট কম হলে (ন্যূনতম % এর নিচে) নির্বাচন বাতিল
     · প্রার্থী আসনের সমান বা কম হলে বিনা প্রতিদ্বন্দ্বিতায় জয়ী
     · শেষ আসনে সমান ভোট হলে শুধু তাঁদের মধ্যে ২৪ ঘণ্টার আবার ভোট
     · কে কাকে ভোট দিলেন কোথাও লেখা থাকে না — শুধু "ভোট দিয়েছেন" আর গোপন গণনা
     ================================================================= */
  const SYMBOLS = ["🌹","🌳","⭐","🐝","🕊️","🌙","☀️","🌾","⛵","🔔","🏠","📚","🌻","🐟","🦚","🍀","🪔","⚖️","🚲","☂️"];
  const elRef = (oid, eid) => orgRef(oid).collection("elections").doc(eid);
  const tallyRef = (oid, eid, round) => elRef(oid, eid).collection("private").doc("tally_" + (round || 1));
  function needTimes(d) {
    const now = Date.now();
    const a = Number(d.applyEndAt), vs = Number(d.voteStartAt), ve = Number(d.voteEndAt);
    if (!(a > now + 10 * 60000)) throw new HttpsError("invalid-argument", "আবেদনের শেষ সময় এখন থেকে অন্তত ১০ মিনিট পরে দিন");
    if (!(vs >= a)) throw new HttpsError("invalid-argument", "ভোট শুরু হবে আবেদন বন্ধ হওয়ার পরে");
    if (!(ve >= vs + 3600000)) throw new HttpsError("invalid-argument", "ভোট অন্তত ১ ঘণ্টা চলবে");
    if (ve > now + 90 * 86400000) throw new HttpsError("invalid-argument", "পুরো নির্বাচন ৯০ দিনের মধ্যে শেষ করুন");
    return { a, vs, ve };
  }
  async function electionCreate(me, d) {
    const oid = id(d.orgId, "সংগঠন");
    const title = str(d.title, 3, 80, "নির্বাচনের নাম");
    const post = str(d.post, 2, 40, "পদের নাম");
    const seats = Math.round(Number(d.seats) || 1);
    if (!(seats >= 1 && seats <= 20)) throw new HttpsError("invalid-argument", "আসন ১ থেকে ২০");
    const maxChoices = Math.round(Number(d.maxChoices) || seats);
    if (!(maxChoices >= 1 && maxChoices <= seats)) throw new HttpsError("invalid-argument", "একজন কতজনকে বাছবেন — ১ থেকে আসনসংখ্যা পর্যন্ত");
    const note = optStr(d.note, 800);
    const t = needTimes(d);
    const ref = orgRef(oid).collection("elections").doc();
    await db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      tx.set(ref, {
        title, post, seats, maxChoices, note, status: "draft",
        applyEndAt: Timestamp.fromMillis(t.a), voteStartAt: Timestamp.fromMillis(t.vs), voteEndAt: Timestamp.fromMillis(t.ve),
        quorumPct: org.quorumPct || 30, round: 1, winners: [], candidateCount: 0, ballotCount: 0,
        createdBy: me.uid, createdByName: me.name, publishBy: [], publishNames: [], createdAt: FieldValue.serverTimestamp(),
      });
      audit(tx, oid, me, "election_create", { detail: `${title} — ${post} (${seats} আসন)` });
    });
    return { ok: true, electionId: ref.id };
  }
  async function electionPublish(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      const es = await tx.get(elRef(oid, eid));
      if (!es.exists || es.data().status !== "draft") throw new HttpsError("failed-precondition", "এই নির্বাচন আর খসড়া নেই");
      const e = es.data();
      if (e.applyEndAt.toMillis() <= Date.now() + 5 * 60000) throw new HttpsError("failed-precondition", "আবেদনের সময় পেরিয়ে যাচ্ছে — নির্বাচনটা বাতিল করে নতুন সময় দিয়ে আবার তৈরি করুন");
      const by = e.publishBy || [];
      if (by.includes(me.uid)) throw new HttpsError("already-exists", "আপনি আগেই অনুমতি দিয়েছেন — আরেকজন অ্যাডমিন লাগবে");
      const newBy = by.concat(me.uid), names = (e.publishNames || []).concat(me.name);
      if (newBy.length < need2(org)) {
        tx.update(es.ref, { publishBy: newBy, publishNames: names });
        audit(tx, oid, me, "election_publish_1", { detail: e.title });
        return { ok: true, status: "draft", approvals: newBy.length, need: need2(org) };
      }
      tx.update(es.ref, { status: "open", publishBy: newBy, publishNames: names, publishedAt: FieldValue.serverTimestamp(), publishedMs: Date.now(), eligible: org.memberCount || 1 });
      timer(tx, "election_apply_close", oid, eid, e.applyEndAt.toMillis());
      timer(tx, "election_close", oid, eid, e.voteEndAt.toMillis());
      audit(tx, oid, me, "election_publish", { detail: e.title });
      return { ok: true, status: "open" };
    });
  }
  async function electionCancel(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    const reason = optStr(d.reason, 300);
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid, true);
      await needAdmin(tx, oid, me.uid);
      const es = await tx.get(elRef(oid, eid));
      if (!es.exists || !["draft", "open"].includes(es.data().status)) throw new HttpsError("failed-precondition", "এই নির্বাচন আর বাতিল করা যায় না");
      const e = es.data();
      if (e.status === "draft") {
        tx.update(es.ref, { status: "cancelled", cancelReason: reason, decidedAt: FieldValue.serverTimestamp() });
        audit(tx, oid, me, "election_cancel", { detail: e.title });
        return { ok: true, status: "cancelled" };
      }
      // প্রকাশিত নির্বাচন বাতিলে দুই-অ্যাডমিন — একজন একা চলমান নির্বাচন থামাতে পারেন না
      const by = e.cancelBy || [];
      if (by.includes(me.uid)) throw new HttpsError("already-exists", "আপনি আগেই বাতিলের অনুমতি দিয়েছেন — আরেকজন অ্যাডমিন লাগবে");
      const newBy = by.concat(me.uid), names = (e.cancelNames || []).concat(me.name);
      if (newBy.length < need2(org)) {
        tx.update(es.ref, { cancelBy: newBy, cancelNames: names, cancelReason: reason || e.cancelReason || "" });
        audit(tx, oid, me, "election_cancel_1", { detail: e.title });
        return { ok: true, status: "open", approvals: newBy.length };
      }
      tx.update(es.ref, { status: "cancelled", cancelBy: newBy, cancelNames: names, cancelReason: reason || e.cancelReason || "", decidedAt: FieldValue.serverTimestamp() });
      tx.delete(db.collection("orgTimers").doc(`election_apply_close_${oid}_${eid}`));
      tx.delete(db.collection("orgTimers").doc(`election_close_${oid}_${eid}`));
      audit(tx, oid, me, "election_cancel", { detail: e.title });
      return { ok: true, status: "cancelled" };
    });
  }
  function eligibleFor(e, m) {
    const joined = m.joinedAt && m.joinedAt.toMillis ? m.joinedAt.toMillis() : 0;
    return joined <= (e.publishedMs || 0);
  }
  async function candidateApply(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    const symbol = SYMBOLS.includes(d.symbol) ? d.symbol : null;
    if (!symbol) throw new HttpsError("invalid-argument", "একটা মার্কা বাছুন");
    const statement = optStr(d.statement, 500);
    return db.runTransaction(async (tx) => {
      await getOrg(tx, oid);
      const m = await needMember(tx, oid, me.uid);
      const es = await tx.get(elRef(oid, eid));
      if (!es.exists || es.data().status !== "open") throw new HttpsError("failed-precondition", "নির্বাচন খোলা নেই");
      const e = es.data();
      if (Date.now() >= e.applyEndAt.toMillis()) throw new HttpsError("failed-precondition", "প্রার্থী হওয়ার সময় শেষ");
      if (!eligibleFor(e, m)) throw new HttpsError("permission-denied", "নির্বাচন ঘোষণার পরে সদস্য হয়েছেন — এতে প্রার্থী হতে পারবেন না");
      const all = await tx.get(elRef(oid, eid).collection("candidates"));
      const mine = all.docs.find((c) => c.id === me.uid);
      if (mine && mine.data().status === "ok") throw new HttpsError("already-exists", "আপনি আগেই প্রার্থী");
      if (mine && mine.data().status === "removed") throw new HttpsError("permission-denied", "অ্যাডমিনরা আপনাকে এই নির্বাচন থেকে বাদ দিয়েছেন");
      if (all.docs.some((c) => c.id !== me.uid && c.data().status === "ok" && c.data().symbol === symbol)) throw new HttpsError("already-exists", "এই মার্কা আরেকজন নিয়েছেন — অন্যটা বাছুন");
      tx.set(elRef(oid, eid).collection("candidates").doc(me.uid), {
        uid: me.uid, name: me.name, photo: me.photo, memberNo: m.memberNo || 0, title: m.title || "সদস্য",
        symbol, statement, status: "ok", appliedAt: FieldValue.serverTimestamp(),
      });
      tx.update(es.ref, { candidateCount: FieldValue.increment(1) });
      audit(tx, oid, me, "candidate_apply", { detail: `${e.title} — ${symbol}` });
      return { ok: true };
    });
  }
  async function candidateWithdraw(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    await db.runTransaction(async (tx) => {
      const es = await tx.get(elRef(oid, eid));
      const cs = await tx.get(elRef(oid, eid).collection("candidates").doc(me.uid));
      if (!es.exists || es.data().status !== "open" || Date.now() >= es.data().applyEndAt.toMillis()) throw new HttpsError("failed-precondition", "আবেদনের সময় শেষ — এখন আর নাম তোলা যায় না");
      if (!cs.exists || cs.data().status !== "ok") throw new HttpsError("not-found", "আপনি প্রার্থী নন");
      tx.update(cs.ref, { status: "withdrawn", withdrawnAt: FieldValue.serverTimestamp() });
      tx.update(es.ref, { candidateCount: FieldValue.increment(-1) });
      audit(tx, oid, me, "candidate_withdraw", { detail: es.data().title });
    });
    return { ok: true };
  }
  async function candidateRemove(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন"), target = id(d.uid, "প্রার্থী");
    const reason = str(d.reason, 5, 300, "বাদ দেওয়ার কারণ");
    return db.runTransaction(async (tx) => {
      const org = await getOrg(tx, oid);
      await needAdmin(tx, oid, me.uid);
      if (target === me.uid) throw new HttpsError("failed-precondition", "নিজেকে বাদ দিতে চাইলে \"নাম তুলে নিন\" চাপুন");
      const es = await tx.get(elRef(oid, eid));
      const cs = await tx.get(elRef(oid, eid).collection("candidates").doc(target));
      if (!es.exists || es.data().status !== "open" || Date.now() >= es.data().voteStartAt.toMillis()) throw new HttpsError("failed-precondition", "ভোট শুরুর পরে প্রার্থী বাদ দেওয়া যায় না");
      if (!cs.exists || cs.data().status !== "ok") throw new HttpsError("not-found", "প্রার্থী পাওয়া যায়নি");
      const c = cs.data(), by = c.removeBy || [];
      if (by.includes(me.uid)) throw new HttpsError("already-exists", "আপনি আগেই অনুমতি দিয়েছেন — আরেকজন অ্যাডমিন লাগবে");
      const others = (org.adminCount || 1) - (c.uid && (await member(tx, oid, target) || {}).role === "admin" ? 1 : 0);
      const needN = Math.max(1, Math.min(2, others));
      const newBy = by.concat(me.uid), names = (c.removeNames || []).concat(me.name);
      if (newBy.length < needN) {
        tx.update(cs.ref, { removeBy: newBy, removeNames: names, removeReason: reason });
        audit(tx, oid, me, "candidate_remove_1", { targetUid: target, targetName: c.name, detail: reason });
        return { ok: true, status: "pending" };
      }
      tx.update(cs.ref, { status: "removed", removeBy: newBy, removeNames: names, removeReason: reason, removedAt: FieldValue.serverTimestamp() });
      tx.update(es.ref, { candidateCount: FieldValue.increment(-1) });
      audit(tx, oid, me, "candidate_remove", { targetUid: target, targetName: c.name, detail: reason });
      return { ok: true, status: "removed" };
    });
  }
  async function electionVote(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    const choices = Array.isArray(d.choices) ? [...new Set(d.choices.map(String))] : [];
    return db.runTransaction(async (tx) => {
      await getOrg(tx, oid, true);
      const m = await needMember(tx, oid, me.uid);
      const es = await tx.get(elRef(oid, eid));
      if (!es.exists || !["open", "runoff"].includes(es.data().status)) throw new HttpsError("failed-precondition", "ভোট খোলা নেই");
      const e = es.data(), now = Date.now(), round = e.round || 1;
      if (now < e.voteStartAt.toMillis()) throw new HttpsError("failed-precondition", "ভোট এখনো শুরু হয়নি");
      if (now >= e.voteEndAt.toMillis()) throw new HttpsError("failed-precondition", "ভোটের সময় শেষ");
      if (!eligibleFor(e, m)) throw new HttpsError("permission-denied", "নির্বাচন ঘোষণার পরে সদস্য হয়েছেন — এতে ভোট দিতে পারবেন না");
      const bref = elRef(oid, eid).collection("ballots").doc(round === 1 ? me.uid : `${me.uid}_r${round}`);
      const b = await tx.get(bref);
      if (b.exists) throw new HttpsError("already-exists", "আপনি আগেই ভোট দিয়েছেন — একবারই দেওয়া যায়");
      const allowed = round === 1 ? null : (e.runoffUids || []);
      const maxC = round === 1 ? (e.maxChoices || 1) : (e.runoffSeats || 1);
      if (!choices.length || choices.length > maxC) throw new HttpsError("invalid-argument", `১ থেকে ${maxC} জন প্রার্থী বাছুন`);
      const cands = await tx.get(elRef(oid, eid).collection("candidates"));
      const ok = new Set(cands.docs.filter((c) => c.data().status === "ok").map((c) => c.id));
      if (choices.some((c) => !ok.has(c) || (allowed && !allowed.includes(c)))) throw new HttpsError("invalid-argument", "প্রার্থী ঠিক নেই — পাতা আবার খুলে দেখুন");
      const tref = tallyRef(oid, eid, round);
      const inc = {}; choices.forEach((c) => { inc[c] = FieldValue.increment(1); });
      tx.set(tref, inc, { merge: true });
      tx.set(bref, { at: FieldValue.serverTimestamp(), round }); // কাকে দিলেন লেখা থাকে না
      tx.update(es.ref, { ballotCount: FieldValue.increment(1) });
      return { ok: true };
    });
  }
  // জয়ীদের পদবি দেওয়া; আগে যাঁরা এই পদে ছিলেন (জয়ী নন) তাঁরা "সদস্য" (প্রতিষ্ঠাতা হলে "প্রতিষ্ঠাতা")
  function applyWinners(tx, oid, org, e, winners, mems) {
    return () => {
      mems.docs.forEach((m) => {
        const x = m.data();
        if (winners.includes(m.id)) tx.update(m.ref, { title: e.post });
        else if (x.title === e.post) tx.update(m.ref, { title: m.id === org.createdBy ? "প্রতিষ্ঠাতা" : (x.role === "admin" ? "অ্যাডমিন" : "সদস্য") });
      });
    };
  }
  async function electionStep(oid, eid) {
    const sys = { uid: "system", name: "নির্বাচনের ফলাফল" };
    await db.runTransaction(async (tx) => {
      const os = await tx.get(orgRef(oid));
      const es = await tx.get(elRef(oid, eid));
      if (!os.exists || !es.exists) return;
      const org = os.data(), e = es.data(), now = Date.now();
      if (!["open", "runoff"].includes(e.status)) return;
      const cands = await tx.get(elRef(oid, eid).collection("candidates"));
      const ok = cands.docs.filter((c) => c.data().status === "ok").map((c) => ({ id: c.id, ...c.data() }));
      // transaction-এ সব পড়া আগে, লেখা পরে
      const round = e.round || 1;
      const ts = await tx.get(tallyRef(oid, eid, round));
      const mems = await tx.get(orgRef(oid).collection("members").where("status", "==", "active"));
      // ১) আবেদন বন্ধের পর — প্রার্থী না থাকলে বাতিল, আসনের সমান/কম হলে বিনা প্রতিদ্বন্দ্বিতায়
      if (e.status === "open" && now >= e.applyEndAt.toMillis() && !e.applyClosed) {
        if (!ok.length) {
          tx.update(es.ref, { status: "void", voidReason: "কেউ প্রার্থী হননি", applyClosed: true, decidedAt: FieldValue.serverTimestamp() });
          audit(tx, oid, sys, "election_void", { detail: `${e.title} — কেউ প্রার্থী হননি` });
          return;
        }
        if (ok.length <= e.seats) {
          const winners = ok.map((c) => c.id);
          applyWinners(tx, oid, org, e, winners, mems)();
          tx.update(es.ref, { status: "done", unopposed: true, applyClosed: true, winners, winnerNames: ok.map((c) => c.name), results: ok.map((c) => ({ uid: c.id, name: c.name, symbol: c.symbol, votes: null })), decidedAt: FieldValue.serverTimestamp() });
          tx.delete(db.collection("orgTimers").doc(`election_close_${oid}_${eid}`));
          audit(tx, oid, sys, "election_done", { detail: `${e.title} — বিনা প্রতিদ্বন্দ্বিতায়: ${ok.map((c) => c.name).join(", ")}` });
          return;
        }
        if (now < e.voteEndAt.toMillis()){ tx.update(es.ref, { applyClosed: true }); return; }
      }
      if (now < e.voteEndAt.toMillis()) return;
      // ২) ভোট শেষ — গণনা
      const tally = ts.exists ? ts.data() : {};
      const pool = round === 1 ? ok : ok.filter((c) => (e.runoffUids || []).includes(c.id));
      const seatsLeft = round === 1 ? e.seats : (e.runoffSeats || 1);
      const prevWinners = round === 1 ? [] : (e.winners || []);
      const needVotes = Math.ceil((e.eligible || 1) * (e.quorumPct || 30) / 100);
      const ballots = e.ballotCount || 0;
      const roundBallots = round === 1 ? ballots : ballots - (e.ballotsBeforeRunoff || 0);
      if (round === 1 && ballots < needVotes) {
        tx.update(es.ref, { applyClosed: true, status: "void", voidReason: `যথেষ্ট ভোট পড়েনি (দরকার ছিল ${needVotes}, পড়েছে ${ballots})`, decidedAt: FieldValue.serverTimestamp(), results: pool.map((c) => ({ uid: c.id, name: c.name, symbol: c.symbol, votes: tally[c.id] || 0 })) });
        audit(tx, oid, sys, "election_void", { detail: `${e.title} — যথেষ্ট ভোট পড়েনি` });
        return;
      }
      const ranked = pool.map((c) => ({ uid: c.id, name: c.name, symbol: c.symbol, votes: tally[c.id] || 0 })).sort((a, b) => b.votes - a.votes);
      let winners = [], tied = [];
      if (ranked.length <= seatsLeft) winners = ranked.map((r) => r.uid);
      else {
        const cut = ranked[seatsLeft - 1].votes;
        const above = ranked.filter((r) => r.votes > cut), at = ranked.filter((r) => r.votes === cut);
        if (above.length + at.length === seatsLeft) winners = above.concat(at).map((r) => r.uid);
        else { winners = above.map((r) => r.uid); tied = at.map((r) => r.uid); }
      }
      const allWinners = prevWinners.concat(winners);
      const roundResults = (e.results || []).concat([{ round, rows: ranked, ballots: roundBallots }]);
      if (tied.length && round < 3) {
        // শেষ আসনে সমান — শুধু তাঁদের মধ্যে ২৪ ঘণ্টার আবার ভোট
        const vs = now, ve = now + 24 * 3600000;
        tx.update(es.ref, { applyClosed: true, status: "runoff", round: round + 1, runoffUids: tied, runoffSeats: seatsLeft - winners.length, winners: allWinners,
          voteStartAt: Timestamp.fromMillis(vs), voteEndAt: Timestamp.fromMillis(ve), ballotsBeforeRunoff: ballots, results: roundResults });
        timer(tx, "election_close", oid, eid, ve);
        audit(tx, oid, sys, "election_runoff", { detail: `${e.title} — সমান ভোট, আবার ভোট: ${ranked.filter((r) => tied.includes(r.uid)).map((r) => r.name).join(", ")}` });
        return;
      }
      if (tied.length) winners = winners.concat(tied.slice(0, seatsLeft - winners.length)); // তিনবারেও সমান — আগে যিনি আবেদন করেছিলেন
      const finalWinners = prevWinners.concat(winners);
      applyWinners(tx, oid, org, e, finalWinners, mems)();
      const names = ok.filter((c) => finalWinners.includes(c.id)).map((c) => c.name);
      tx.update(es.ref, { applyClosed: true, status: "done", winners: finalWinners, winnerNames: names, results: roundResults, decidedAt: FieldValue.serverTimestamp() });
      audit(tx, oid, sys, "election_done", { detail: `${e.title} — জয়ী: ${names.join(", ")}` });
    });
  }
  // ফোন থেকে "সময় হয়ে গেছে, দেখো" — সার্ভার নিজের ঘড়িতে মিলিয়ে কাজ করে (ফোনের ঘড়িতে না)
  async function electionSync(me, d) {
    const oid = id(d.orgId, "সংগঠন"), eid = id(d.electionId, "নির্বাচন");
    await electionStep(oid, eid);
    return { ok: true };
  }

  /* =================================================================
     একটাই দরজা — orgApi
     ================================================================= */
  const ACTIONS_MAP = {
    create, update, apply, cancelApply, decide, leave,
    postCreate, postEdit, postRemove, txCreate, txDecide,
    proposalCreate, proposalCancel, vote,
    aidSave, setTitle, adminAction, resignRequest, resignCancel, deleteRequest, deleteCancel, deleteFinalize,
    electionCreate, electionPublish, electionCancel, candidateApply, candidateWithdraw, candidateRemove, electionVote, electionSync,
  };
  const orgApi = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const fn = ACTIONS_MAP[d.action];
    if (!fn) throw new HttpsError("invalid-argument", "অজানা কাজ");
    try { return await fn(me, d); }
    catch (e) {
      if (e instanceof HttpsError) throw e;
      console.error(JSON.stringify({ event: "ORG_API_FAILED", action: d.action, error: String(e && e.message || e) }));
      throw new HttpsError("internal", "হয়নি — আবার চেষ্টা করুন");
    }
  });

  /* ⏱️ প্রতি ৫ মিনিটে — নির্ধারিত পোস্ট প্রকাশ, পোস্টের মেয়াদ শেষ, ভোটের ফলাফল */
  const orgTick = onSchedule("every 5 minutes", async () => {
    const due = await db.collection("orgTimers").where("at", "<=", Timestamp.now()).orderBy("at").limit(200).get();
    for (const t of due.docs) {
      const { kind, orgId: oid, refId } = t.data();
      try {
        if (kind === "proposal_close") await closeProposal(oid, refId);
        else if (kind === "election_apply_close" || kind === "election_close") await electionStep(oid, refId);
        else if (kind === "post_publish" || kind === "post_expire") {
          const pref = orgRef(oid).collection("posts").doc(refId);
          await db.runTransaction(async (tx) => {
            const p = await tx.get(pref);
            if (!p.exists) return;
            if (kind === "post_publish" && p.data().status === "scheduled") tx.update(pref, { status: "published" });
            if (kind === "post_expire" && ["published", "scheduled"].includes(p.data().status)) tx.update(pref, { status: "expired" });
          });
        }
        await t.ref.delete();
      } catch (e) {
        console.error(JSON.stringify({ event: "ORG_TICK_FAILED", kind, oid, refId, error: String(e && e.message || e) }));
      }
    }
  });

  /* ❤️ লাইক আর 💬 মন্তব্য গোনা — ফোন সংখ্যা বদলাতে পারে না, এখানে গোনা হয় */
  const orgPostLikeCount = onDocumentWritten("orgs/{orgId}/posts/{postId}/likes/{uid}", async (event) => {
    const before = event.data.before.exists, after = event.data.after.exists;
    if (before === after) return;
    await orgRef(event.params.orgId).collection("posts").doc(event.params.postId)
      .update({ likeCount: FieldValue.increment(after ? 1 : -1) }).catch(() => {});
  });
  const countComments = (kind) => async (event) => {
    const before = event.data.before.exists, after = event.data.after.exists;
    if (before === after) return;
    await orgRef(event.params.orgId).collection(kind).doc(event.params.parentId)
      .update({ commentCount: FieldValue.increment(after ? 1 : -1) }).catch(() => {});
  };
  const orgPostCommentCount = onDocumentWritten("orgs/{orgId}/posts/{parentId}/comments/{cid}", countComments("posts"));
  const orgProposalCommentCount = onDocumentWritten("orgs/{orgId}/proposals/{parentId}/comments/{cid}", countComments("proposals"));

  return { orgApi, orgTick, orgPostLikeCount, orgPostCommentCount, orgProposalCommentCount };
};
