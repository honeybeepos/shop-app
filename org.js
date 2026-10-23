/* =====================================================================
   🤝🐝 Honey Bee Org — সংগঠন (ধাপ ১: সংগঠন খোলা, আবেদন, অনুমোদন, ছেড়ে যাওয়া)

   নিরাপত্তার মূল নিয়ম:
   · ফোন থেকে orgs/… -তে সরাসরি কিছু লেখা যায় না (Firestore rules-এ write:false)।
     সব লেখা এখানে, সার্ভারে — প্রতিবার কে ডাকছেন, তিনি সত্যিই অ্যাডমিন কিনা,
     আবেদন এখনো অপেক্ষায় কিনা — সব transaction-এর ভেতরে যাচাই হয়।
   · সদস্য গ্রহণে দুইজন আলাদা অ্যাডমিনের অনুমোদন লাগে (একই জন দুবার গোনা হয় না)।
     সংগঠনে অ্যাডমিন একজনই থাকলে (শুরুতে প্রতিষ্ঠাতা) একজনের অনুমোদনেই হয়।
   · লগইন ছাড়া বা অতিথি (anonymous) লগইনে কিছুই করা যায় না — Google লগইন লাগে।
   · প্রতিটা কাজ auditLogs-এ লেখা থাকে — কে, কখন, কী করলেন। কেউ মুছতে পারেন না।
   ===================================================================== */

module.exports = function makeOrg({ db, FieldValue, onCall, HttpsError }) {
  const ORG_MAX_PER_FOUNDER = 3;          // একজন সর্বোচ্চ কয়টা সংগঠন খুলতে পারবেন
  const REAPPLY_AFTER_MS = 24 * 3600000;  // বাতিল হলে আবার আবেদন — ২৪ ঘণ্টা পর

  function needUser(request) {
    const a = request.auth;
    if (!a) throw new HttpsError("unauthenticated", "আগে Google দিয়ে লগইন করুন");
    if (a.token.firebase && a.token.firebase.sign_in_provider === "anonymous") {
      throw new HttpsError("unauthenticated", "আগে Google দিয়ে লগইন করুন");
    }
    return { uid: a.uid, name: String(a.token.name || "সদস্য").slice(0, 60), photo: a.token.picture || null };
  }
  function str(v, min, max, label) {
    const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    if (s.length < min) throw new HttpsError("invalid-argument", `${label} দিন${min > 1 ? ` (কমপক্ষে ${min} অক্ষর)` : ""}`);
    if (s.length > max) throw new HttpsError("invalid-argument", `${label} সর্বোচ্চ ${max} অক্ষর`);
    return s;
  }
  function optStr(v, max) { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return s.slice(0, max); }
  function phone(v) {
    const d = String(v || "").replace(/[০-৯]/g, (c) => "০১২৩৪৫৬৭৮৯".indexOf(c)).replace(/\D/g, "").replace(/^880/, "0");
    if (!/^01[3-9]\d{8}$/.test(d)) throw new HttpsError("invalid-argument", "সঠিক মোবাইল নম্বর দিন (01XXXXXXXXX)");
    return d;
  }
  function orgId(v) {
    const s = String(v || "");
    if (!/^[A-Za-z0-9]{10,40}$/.test(s)) throw new HttpsError("invalid-argument", "সংগঠন পাওয়া যায়নি");
    return s;
  }
  function audit(tx, oid, actor, action, extra) {
    tx.set(db.collection("orgs").doc(oid).collection("auditLogs").doc(),
      Object.assign({ action, actorUid: actor.uid, actorName: actor.name, at: FieldValue.serverTimestamp() }, extra || {}));
  }
  async function activeMember(tx, oid, uid) {
    const m = await tx.get(db.collection("orgs").doc(oid).collection("members").doc(uid));
    return (m.exists && m.data().status === "active") ? m.data() : null;
  }

  /* ---------- সংগঠন খোলা — প্রতিষ্ঠাতা নিজেই প্রথম অ্যাডমিন ---------- */
  const orgCreate = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const name = str(d.name, 3, 60, "সংগঠনের নাম");
    const desc = str(d.desc, 10, 600, "সংগঠনের পরিচিতি");
    const district = str(d.district, 2, 40, "জেলা");
    const upazila = optStr(d.upazila, 40);
    const area = optStr(d.area, 80);

    const mine = await db.collection("orgs").where("createdBy", "==", me.uid).where("status", "==", "active").get();
    if (mine.size >= ORG_MAX_PER_FOUNDER) {
      throw new HttpsError("resource-exhausted", `একজন সর্বোচ্চ ${ORG_MAX_PER_FOUNDER}টা সংগঠন খুলতে পারেন`);
    }
    const nameLower = name.toLowerCase();
    const dup = await db.collection("orgs").where("district", "==", district).where("nameLower", "==", nameLower).limit(1).get();
    if (!dup.empty) throw new HttpsError("already-exists", "এই জেলায় একই নামের সংগঠন আগে থেকেই আছে");

    const ref = db.collection("orgs").doc();
    await db.runTransaction(async (tx) => {
      tx.set(ref, {
        name, nameLower, desc, district, upazila, area,
        createdBy: me.uid, founderName: me.name,
        status: "active", memberCount: 1, adminCount: 1, nextMemberNo: 2,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(ref.collection("members").doc(me.uid), {
        uid: me.uid, name: me.name, photo: me.photo, role: "admin", title: "প্রতিষ্ঠাতা",
        memberNo: 1, status: "active", joinedAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("orgUserIndex").doc(me.uid), { orgs: { [ref.id]: { name, role: "admin" } } }, { merge: true });
      audit(tx, ref.id, me, "org_create", { name });
    });
    return { ok: true, orgId: ref.id };
  });

  /* ---------- সদস্য হওয়ার আবেদন ---------- */
  const orgApply = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const oid = orgId(d.orgId);
    const ph = phone(d.phone);
    const note = optStr(d.note, 300);
    const oref = db.collection("orgs").doc(oid);
    const rref = oref.collection("requests").doc(me.uid);
    await db.runTransaction(async (tx) => {
      const org = await tx.get(oref);
      if (!org.exists || org.data().status !== "active") throw new HttpsError("not-found", "সংগঠন পাওয়া যায়নি");
      if (await activeMember(tx, oid, me.uid)) throw new HttpsError("already-exists", "আপনি আগেই এই সংগঠনের সদস্য");
      const old = await tx.get(rref);
      if (old.exists) {
        const o = old.data();
        if (o.status === "pending") throw new HttpsError("already-exists", "আপনার আবেদন আগেই জমা আছে — অনুমোদনের অপেক্ষায়");
        const at = o.decidedAt && o.decidedAt.toMillis ? o.decidedAt.toMillis() : 0;
        if (o.status === "rejected" && Date.now() - at < REAPPLY_AFTER_MS) {
          throw new HttpsError("failed-precondition", "আবেদন বাতিল হয়েছিল — ২৪ ঘণ্টা পর আবার আবেদন করতে পারবেন");
        }
      }
      tx.set(rref, {
        uid: me.uid, name: me.name, photo: me.photo, phone: ph, note,
        status: "pending", approvedBy: [], approvedNames: [],
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(db.collection("orgUserIndex").doc(me.uid), { applied: { [oid]: { name: org.data().name } } }, { merge: true });
    });
    return { ok: true };
  });

  /* ---------- নিজের অপেক্ষমাণ আবেদন তুলে নেওয়া ---------- */
  const orgCancelApply = onCall(async (request) => {
    const me = needUser(request);
    const oid = orgId((request.data || {}).orgId);
    const rref = db.collection("orgs").doc(oid).collection("requests").doc(me.uid);
    await db.runTransaction(async (tx) => {
      const r = await tx.get(rref);
      if (!r.exists || r.data().status !== "pending") throw new HttpsError("not-found", "অপেক্ষমাণ আবেদন নেই");
      tx.delete(rref);
      tx.set(db.collection("orgUserIndex").doc(me.uid), { applied: { [oid]: FieldValue.delete() } }, { merge: true });
    });
    return { ok: true };
  });

  /* ---------- অ্যাডমিনের সিদ্ধান্ত: অনুমোদন / বাতিল ---------- */
  const orgDecide = onCall(async (request) => {
    const me = needUser(request);
    const d = request.data || {};
    const oid = orgId(d.orgId);
    const target = String(d.uid || "");
    if (!/^[A-Za-z0-9]{10,128}$/.test(target)) throw new HttpsError("invalid-argument", "আবেদন পাওয়া যায়নি");
    const approve = d.approve === true;
    const oref = db.collection("orgs").doc(oid);
    const rref = oref.collection("requests").doc(target);
    return db.runTransaction(async (tx) => {
      const org = await tx.get(oref);
      if (!org.exists || org.data().status !== "active") throw new HttpsError("not-found", "সংগঠন পাওয়া যায়নি");
      const admin = await activeMember(tx, oid, me.uid);
      if (!admin || admin.role !== "admin") throw new HttpsError("permission-denied", "শুধু এই সংগঠনের অ্যাডমিন এটা করতে পারেন");
      const r = await tx.get(rref);
      if (!r.exists || r.data().status !== "pending") throw new HttpsError("failed-precondition", "এই আবেদন আর অপেক্ষায় নেই");
      const req = r.data();
      const already = await activeMember(tx, oid, target);

      if (!approve) {
        tx.update(rref, { status: "rejected", rejectedBy: me.uid, rejectedName: me.name, decidedAt: FieldValue.serverTimestamp() });
        tx.set(db.collection("orgUserIndex").doc(target), { applied: { [oid]: FieldValue.delete() } }, { merge: true });
        audit(tx, oid, me, "member_reject", { targetUid: target, targetName: req.name });
        return { ok: true, status: "rejected" };
      }
      const by = Array.isArray(req.approvedBy) ? req.approvedBy : [];
      if (by.includes(me.uid)) throw new HttpsError("already-exists", "আপনি আগেই অনুমোদন দিয়েছেন — অন্য একজন অ্যাডমিনের অনুমোদন লাগবে");
      const need = (org.data().adminCount || 1) >= 2 ? 2 : 1;
      const newBy = by.concat(me.uid);
      const names = (req.approvedNames || []).concat(me.name);
      if (newBy.length < need || already) {
        tx.update(rref, { approvedBy: newBy, approvedNames: names });
        audit(tx, oid, me, "member_approve_1", { targetUid: target, targetName: req.name });
        return { ok: true, status: "pending", approvals: newBy.length, need };
      }
      const no = org.data().nextMemberNo || 2;
      tx.set(oref.collection("members").doc(target), {
        uid: target, name: req.name, photo: req.photo || null, phone: req.phone, role: "member", title: "সদস্য",
        memberNo: no, status: "active", joinedAt: FieldValue.serverTimestamp(), approvedBy: newBy, approvedNames: names,
      });
      tx.update(oref, { memberCount: FieldValue.increment(1), nextMemberNo: no + 1, updatedAt: FieldValue.serverTimestamp() });
      tx.update(rref, { status: "approved", approvedBy: newBy, approvedNames: names, decidedAt: FieldValue.serverTimestamp() });
      tx.set(db.collection("orgUserIndex").doc(target), {
        orgs: { [oid]: { name: org.data().name, role: "member" } }, applied: { [oid]: FieldValue.delete() },
      }, { merge: true });
      audit(tx, oid, me, "member_approve", { targetUid: target, targetName: req.name, memberNo: no });
      return { ok: true, status: "approved", memberNo: no };
    });
  });

  /* ---------- নিজে সংগঠন ছেড়ে যাওয়া ---------- */
  const orgLeave = onCall(async (request) => {
    const me = needUser(request);
    const oid = orgId((request.data || {}).orgId);
    const oref = db.collection("orgs").doc(oid);
    const mref = oref.collection("members").doc(me.uid);
    await db.runTransaction(async (tx) => {
      const org = await tx.get(oref);
      if (!org.exists) throw new HttpsError("not-found", "সংগঠন পাওয়া যায়নি");
      const m = await activeMember(tx, oid, me.uid);
      if (!m) throw new HttpsError("not-found", "আপনি এই সংগঠনের সদস্য নন");
      const o = org.data();
      if (m.role === "admin" && (o.adminCount || 1) <= 1 && (o.memberCount || 1) > 1) {
        throw new HttpsError("failed-precondition", "আপনি একমাত্র অ্যাডমিন — আগে আরেকজনকে অ্যাডমিন করুন, তারপর ছাড়তে পারবেন");
      }
      tx.update(mref, { status: "left", leftAt: FieldValue.serverTimestamp() });
      const upd = { memberCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() };
      if (m.role === "admin") upd.adminCount = FieldValue.increment(-1);
      tx.update(oref, upd);
      tx.set(db.collection("orgUserIndex").doc(me.uid), { orgs: { [oid]: FieldValue.delete() } }, { merge: true });
      audit(tx, oid, me, "member_leave", {});
    });
    return { ok: true };
  });

  return { orgCreate, orgApply, orgCancelApply, orgDecide, orgLeave };
};
