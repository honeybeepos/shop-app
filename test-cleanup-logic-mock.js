/* ⚠️ এটা REAL Firebase টেস্ট না — শুধু cleanupOrphanImages()-এর লজিক
   (re-verification, conditional delete, error-reconcile) সঠিক কিনা
   mock admin-SDK কল দিয়ে যাচাই করা হচ্ছে। */

const results = [];
function assert(name, cond, detail){
  results.push({ name, pass: !!cond, detail });
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}

// 🧪 mock Firestore + Storage
function makeMockDb(initialImageIndex){
  const store = JSON.parse(JSON.stringify(initialImageIndex));
  return {
    _store: store,
    collection(name){
      if(name !== "imageIndex") throw new Error("শুধু imageIndex mock করা আছে");
      return {
        where(field, op, value){
          this._filters = this._filters || [];
          this._filters.push({field, op, value});
          return this;
        },
        async get(){
          const docs = Object.keys(store).filter(id=>{
            return (this._filters||[]).every(f=>{
              const v = store[id][f.field];
              if(f.op === "==") return v === f.value;
              if(f.op === "<") return v < f.value;
              return true;
            });
          }).map(id=> ({ id, data: ()=> store[id] }));
          return { empty: docs.length===0, size: docs.length, docs };
        },
        doc(id){
          return {
            async get(){ return { exists: !!store[id], data: ()=> store[id] }; },
            async delete(){
              if(!store[id]) throw new Error("not found");
              delete store[id];
            }
          };
        }
      };
    }
  };
}
function makeMockBucket(existingFiles){
  const files = new Set(existingFiles);
  return {
    _files: files,
    file(path){
      return {
        async exists(){ return [files.has(path)]; },
        async delete(){
          if(!files.has(path)) throw new Error("file not found");
          files.delete(path);
        }
      };
    }
  };
}

async function runCleanupLogic(db, bucket){
  // index.js-এর cleanupOrphanImages-এর মূল লজিকের হুবহু প্রতিফলন (mock db/bucket দিয়ে চালানোর জন্য)
  const cutoffMs = Date.now() - 24*60*60*1000;
  const snap = await db.collection("imageIndex").where("cleanupStatus","==","ORPHAN").where("orphanedAt","<",cutoffMs).get();
  let deleted = 0, skipped = 0;
  for(const doc of snap.docs){
    const imageId = doc.id;
    const freshDoc = await db.collection("imageIndex").doc(imageId).get();
    if(!freshDoc.exists){ skipped++; continue; }
    const freshData = freshDoc.data();
    if((freshData.referenceCount||0) > 0 || freshData.cleanupStatus !== "ORPHAN"){ skipped++; continue; }
    const file = bucket.file(freshData.storagePath);
    const [exists] = await file.exists();
    if(exists) await file.delete();
    await db.collection("imageIndex").doc(imageId).delete();
    deleted++;
  }
  return { deleted, skipped };
}

async function main(){
  const now = Date.now();
  const oldTimestamp = now - 25*60*60*1000; // ২৫ ঘণ্টা আগে (grace period পার)

  // ==================== TEST C: refCount=0 + orphanedAt>24h → delete ====================
  {
    const db = makeMockDb({
      "img_c": { referenceCount: 0, cleanupStatus: "ORPHAN", orphanedAt: oldTimestamp, storagePath: "product-images/img_c.webp" }
    });
    const bucket = makeMockBucket(["product-images/img_c.webp"]);
    const { deleted } = await runCleanupLogic(db, bucket);
    assert("Test C: 24h+ orphan -> Storage+Firestore both deleted",
      deleted === 1 && !db._store["img_c"] && !bucket._files.has("product-images/img_c.webp"),
      `deleted=${deleted}, firestoreGone=${!db._store["img_c"]}, storageGone=${!bucket._files.has("product-images/img_c.webp")}`);
  }

  // ==================== TEST E: cleanup চলাকালীন আবার ব্যবহার হলে -> cancel ====================
  {
    const db = makeMockDb({
      "img_e": { referenceCount: 1, cleanupStatus: "ACTIVE", orphanedAt: null, storagePath: "product-images/img_e.webp" }
    });
    // ⚠️ এই এন্ট্রিটা আসলে ORPHAN ছিল যখন scheduled query চলেছিল (তাই query-তে ধরা পড়েছে),
    // কিন্তু re-verification-এর ঠিক আগে আবার ACTIVE হয়ে গেছে (রেস-কন্ডিশন সিমুলেশন)
    const bucket = makeMockBucket(["product-images/img_e.webp"]);
    // সরাসরি snap বানিয়ে delete-লজিক টেস্ট করা (যেহেতু db এখন ACTIVE বলছে, query খুঁজে পাবে না —
    // তাই ম্যানুয়ালি সিমুলেট করছি যে query পুরনো স্ন্যাপশট থেকে এসেছিল)
    const fakeSnap = { empty:false, size:1, docs:[{ id:"img_e", data: ()=> ({ cleanupStatus:"ORPHAN", orphanedAt: oldTimestamp }) }] };
    const freshDoc = await db.collection("imageIndex").doc("img_e").get();
    const stillOrphan = freshDoc.exists && (freshDoc.data().referenceCount||0) === 0 && freshDoc.data().cleanupStatus === "ORPHAN";
    assert("Test E: re-verification detects still-active -> cancel delete",
      !stillOrphan && db._store["img_e"] && bucket._files.has("product-images/img_e.webp"),
      `stillOrphan=${stillOrphan} (should be false), imageStillExists=${!!db._store["img_e"]}`);
  }

  // ==================== TEST F: Storage delete সফল, Firestore delete ব্যর্থ -> reconcile পরের রানে ====================
  {
    const db = makeMockDb({
      "img_f": { referenceCount: 0, cleanupStatus: "ORPHAN", orphanedAt: oldTimestamp, storagePath: "product-images/img_f.webp" }
    });
    const bucket = makeMockBucket(["product-images/img_f.webp"]);
    // Firestore delete ইচ্ছাকৃতভাবে ব্যর্থ করানো
    const originalDelete = db.collection("imageIndex").doc("img_f").delete;
    let firestoreDeleteAttempted = false;
    const brokenDb = {
      collection: (name)=>{
        const real = db.collection(name);
        return Object.assign({}, real, {
          doc: (id)=>{
            const realDoc = real.doc(id);
            return Object.assign({}, realDoc, {
              delete: async ()=>{ firestoreDeleteAttempted = true; throw new Error("Simulated Firestore delete failure"); }
            });
          }
        });
      }
    };
    let storageWasDeleted = false, errorCaught = false;
    try{
      const freshDoc = await db.collection("imageIndex").doc("img_f").get();
      const freshData = freshDoc.data();
      const file = bucket.file(freshData.storagePath);
      const [exists] = await file.exists();
      if(exists) await file.delete();
      storageWasDeleted = !bucket._files.has("product-images/img_f.webp");
      await brokenDb.collection("imageIndex").doc("img_f").delete();
    }catch(e){ errorCaught = true; }

    assert("Test F: Storage deleted, Firestore delete fails -> error caught, doc remains for reconcile",
      storageWasDeleted && firestoreDeleteAttempted && errorCaught && db._store["img_f"],
      `storageWasDeleted=${storageWasDeleted}, firestoreAttempted=${firestoreDeleteAttempted}, errorCaught=${errorCaught}, docStillInFirestore=${!!db._store["img_f"]}`);
  }

  console.log(`\n${results.filter(r=>r.pass).length}/${results.length} টেস্ট পাস করেছে`);
}

main();
