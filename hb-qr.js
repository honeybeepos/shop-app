/* ============================================================
   hb-qr.js — QR কোড তৈরি (নিজেদের, বাইরের কোনো লাইব্রেরি ছাড়া)

   কেন নিজেরা লিখতে হলো: ZATCA-এর নিয়মে সৌদি দোকানের প্রতিটা রসিদে QR
   ছাপানো আইনত বাধ্যতামূলক। আমাদের POS অফলাইনেও বিক্রি করতে পারে। বাইরের
   CDN থেকে QR লাইব্রেরি আনলে ইন্টারনেট না থাকা অবস্থায় প্রথমবার রসিদ
   ছাপার সময় QR বাদ পড়ে যেতে পারত — সেটা সরাসরি আইন ভাঙা। তাই QR তৈরির
   কাজটা অ্যাপের ভেতরেই রাখা হয়েছে, যাতে ইন্টারনেট থাক বা না থাক,
   প্রতিটা রসিদে QR থাকবেই।

   যা সমর্থন করে: byte mode (যেকোনো UTF-8 লেখা), error correction level
   L/M/Q/H, ভার্সন ১-২০ (প্রায় ৬০০ বাইট পর্যন্ত)। ZATCA-এর প্রথম ধাপের
   QR-এ লাগে ~১১০ বাইট, দ্বিতীয় ধাপে ~৬০০ পর্যন্ত যেতে পারে।

   ব্যবহার:
     var m = HBQR.encode("লেখা");        // m.size, m.get(row, col) → true/false
     HBQR.toCanvas(canvas, "লেখা", {scale:4, margin:4});
     var url = HBQR.toDataURL("লেখা", {scale:4});
   ============================================================ */
(function (root) {
  "use strict";

  /* ---------- GF(256) — ভুল-সংশোধনের হিসাব এই সংখ্যাজগতে হয় ----------
     QR-এর নিয়মে primitive polynomial 0x11D, আর জনক (generator) হিসেবে ২। */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // n সংখ্যক সংশোধন-বাইটের জন্য জনক বহুপদী
  function rsGenerator(n) {
    var g = [1], i, j;
    for (i = 0; i < n; i++) {
      var ng = new Array(g.length + 1).fill(0);
      for (j = 0; j < g.length; j++) {
        ng[j] ^= gfMul(g[j], 1);
        ng[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(data.length + ecLen).fill(0), i, j;
    for (i = 0; i < data.length; i++) res[i] = data[i];
    for (i = 0; i < data.length; i++) {
      var factor = res[i];
      if (factor === 0) continue;
      for (j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  /* ---------- ভার্সন ও ভুল-সংশোধনের ছক ----------
     প্রতিটা সারি: [সংশোধন-বাইট প্রতি ব্লকে, দল-১ ব্লক সংখ্যা, দল-১ ডেটা বাইট,
                    দল-২ ব্লক সংখ্যা, দল-২ ডেটা বাইট]
     ছকটা QR-এর আন্তর্জাতিক মানের (ISO/IEC 18004) ছক। প্রতিটা সারি
     পরীক্ষায় আলাদা করে যাচাই করা হয়েছে — ভুল সারি থাকলে QR পড়া যেত না। */
  var EC_TABLE = {
    L: [
      null,
      [7, 1, 19], [10, 1, 34], [15, 1, 55], [20, 1, 80], [26, 1, 108],
      [18, 2, 68], [20, 2, 78], [24, 2, 97], [30, 2, 116], [18, 2, 68, 2, 69],
      [20, 4, 81], [24, 2, 92, 2, 93], [26, 4, 107], [30, 3, 115, 1, 116], [22, 5, 87, 1, 88],
      [24, 5, 98, 1, 99], [28, 1, 107, 5, 108], [30, 5, 120, 1, 121], [28, 3, 113, 4, 114], [28, 3, 107, 5, 108]
    ],
    M: [
      null,
      [10, 1, 16], [16, 1, 28], [26, 1, 44], [18, 2, 32], [24, 2, 43],
      [16, 4, 27], [18, 4, 31], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
      [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
      [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42]
    ],
    Q: [
      null,
      [13, 1, 13], [22, 1, 22], [18, 2, 17], [26, 2, 24], [18, 2, 15, 2, 16],
      [24, 4, 19], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
      [28, 4, 22, 4, 23], [26, 4, 20, 6, 21], [24, 8, 20, 4, 21], [20, 11, 16, 5, 17], [30, 5, 24, 7, 25],
      [24, 15, 19, 2, 20], [28, 1, 22, 15, 23], [28, 17, 22, 1, 23], [26, 17, 21, 4, 22], [30, 15, 24, 5, 25]
    ],
    H: [
      null,
      [17, 1, 9], [28, 1, 16], [22, 2, 13], [16, 4, 9], [22, 2, 11, 2, 12],
      [28, 4, 15], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
      [24, 3, 12, 8, 13], [28, 7, 14, 4, 15], [22, 12, 11, 4, 12], [24, 11, 12, 5, 13], [24, 11, 12, 7, 13],
      [30, 3, 15, 13, 16], [28, 2, 14, 17, 15], [28, 2, 14, 19, 15], [26, 9, 13, 16, 14], [28, 15, 15, 10, 16]
    ]
  };

  // সারিবদ্ধকরণ নকশার (alignment pattern) কেন্দ্রগুলো — ভার্সন ২ থেকে
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
  ];

  var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var MAX_VERSION = 20;

  function dataCapacity(version, ecl) {
    var t = EC_TABLE[ecl][version];
    return t[1] * t[2] + (t[3] ? t[3] * t[4] : 0);
  }

  function utf8Bytes(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(str));
    var s = unescape(encodeURIComponent(String(str)));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /* ---------- বিট লেখার সহায়ক ---------- */
  function BitBuffer() { this.bits = []; }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };

  function buildCodewords(text, version, ecl) {
    var data = utf8Bytes(text);
    var bb = new BitBuffer();
    bb.put(0x4, 4);                                  // byte mode
    bb.put(data.length, version <= 9 ? 8 : 16);      // কত বাইট
    for (var i = 0; i < data.length; i++) bb.put(data[i], 8);

    var capBits = dataCapacity(version, ecl) * 8;
    if (bb.bits.length > capBits) return null;       // এই ভার্সনে ধরবে না

    var term = Math.min(4, capBits - bb.bits.length);
    bb.put(0, term);
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    var cw = [];
    for (i = 0; i < bb.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      cw.push(b);
    }
    var pads = [0xec, 0x11], p = 0;
    while (cw.length < dataCapacity(version, ecl)) cw.push(pads[p++ % 2]);
    return cw;
  }

  /* ডেটা বাইটগুলোকে ব্লকে ভাগ করে প্রতিটার সংশোধন-বাইট বের করা, তারপর
     QR-এর নিয়ম অনুযায়ী ব্লকগুলো পাশাপাশি মিশিয়ে (interleave) সাজানো */
  function interleave(cw, version, ecl) {
    var t = EC_TABLE[ecl][version];
    var ecLen = t[0];
    var groups = [];
    var at = 0, i, j;
    for (i = 0; i < t[1]; i++) { groups.push(cw.slice(at, at + t[2])); at += t[2]; }
    if (t[3]) for (i = 0; i < t[3]; i++) { groups.push(cw.slice(at, at + t[4])); at += t[4]; }

    var ecBlocks = groups.map(function (g) { return rsEncode(g, ecLen); });

    var out = [];
    var maxData = Math.max.apply(null, groups.map(function (g) { return g.length; }));
    for (i = 0; i < maxData; i++) {
      for (j = 0; j < groups.length; j++) if (i < groups[j].length) out.push(groups[j][i]);
    }
    for (i = 0; i < ecLen; i++) {
      for (j = 0; j < ecBlocks.length; j++) out.push(ecBlocks[j][i]);
    }
    return out;
  }

  /* ---------- ছক (matrix) বানানো ---------- */
  function newMatrix(size) {
    var m = [], r;
    for (r = 0; r < size; r++) m.push(new Int8Array(size).fill(-1)); // -1 = এখনো খালি
    return m;
  }

  function placeFinder(m, row, col) {
    for (var r = -1; r <= 7; r++) {
      for (var c = -1; c <= 7; c++) {
        var rr = row + r, cc = col + c;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        m[rr][cc] = dark ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, version) {
    var centers = ALIGN[version];
    if (!centers || !centers.length) return;
    var size = m.length;
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        var row = centers[a], col = centers[b];
        // তিনটা কোণে finder নকশা আছে, সেখানে বসানো যাবে না
        if ((row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8)) continue;
        for (var r = -2; r <= 2; r++) {
          for (var c = -2; c <= 2; c++) {
            var dark = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
            m[row + r][col + c] = dark ? 1 : 0;
          }
        }
      }
    }
  }

  function placeTiming(m) {
    var size = m.length;
    for (var i = 8; i < size - 8; i++) {
      var v = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === -1) m[6][i] = v;
      if (m[i][6] === -1) m[i][6] = v;
    }
  }

  // format/version তথ্যের ঘরগুলো আগে থেকেই আটকে রাখা হয়, যাতে ডেটা সেখানে না বসে
  function reserveInfo(m, version) {
    var size = m.length, i;
    for (i = 0; i <= 8; i++) {
      if (m[8][i] === -1) m[8][i] = 0;
      if (m[i][8] === -1) m[i][8] = 0;
    }
    for (i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0;
    }
    m[size - 8][8] = 1;                      // সবসময় কালো থাকে এমন একটা ঘর
    if (version >= 7) {
      for (i = 0; i < 6; i++) {
        for (var j = 0; j < 3; j++) {
          m[size - 11 + j][i] = 0;
          m[i][size - 11 + j] = 0;
        }
      }
    }
  }

  function isFunctionModule(reserved, r, c) { return reserved[r][c] === 1; }

  function placeData(m, reserved, bytes) {
    var size = m.length;
    var bitIndex = 0, total = bytes.length * 8;
    function nextBit() {
      if (bitIndex >= total) return 0;                 // বাকি ঘরে ০ (remainder bits)
      var b = (bytes[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
      bitIndex++;
      return b;
    }
    var col = size - 1, upward = true;
    while (col > 0) {
      if (col === 6) col--;                            // ৬ নম্বর কলাম timing, বাদ
      for (var i = 0; i < size; i++) {
        var row = upward ? (size - 1 - i) : i;
        for (var k = 0; k < 2; k++) {
          var cc = col - k;
          if (isFunctionModule(reserved, row, cc)) continue;
          m[row][cc] = nextBit();
        }
      }
      upward = !upward;
      col -= 2;
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
      case 7: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
    }
    return false;
  }

  /* QR-এর নিয়মে চারটা "জরিমানা" হিসাব করে সবচেয়ে কম জরিমানার মুখোশ বাছা হয় —
     এতে বড় কালো/সাদা দাগ কম পড়ে, স্ক্যানারের পড়তে সুবিধা হয়। */
  function penalty(m) {
    var size = m.length, score = 0, r, c, i;

    function runScore(run) { return run >= 5 ? 3 + (run - 5) : 0; }
    for (r = 0; r < size; r++) {
      var run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else { score += runScore(run); run = 1; }
      }
      score += runScore(run);
    }
    for (c = 0; c < size; c++) {
      run = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) run++;
        else { score += runScore(run); run = 1; }
      }
      score += runScore(run);
    }
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    var PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, start, pat) {
      for (var k = 0; k < pat.length; k++) if (get(start + k) !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      for (c = 0; c + 11 <= size; c++) {
        var getR = function (k) { return m[r][k]; };
        if (matches(getR, c, PAT1) || matches(getR, c, PAT2)) score += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r + 11 <= size; r++) {
        var getC = (function (cc) { return function (k) { return m[k][cc]; }; })(c);
        if (matches(getC, r, PAT1) || matches(getC, r, PAT2)) score += 40;
      }
    }
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function bchFormat(data) {           // BCH(15,5)
    var d = data << 10;
    for (var i = 4; i >= 0; i--) if ((d >>> (i + 10)) & 1) d ^= 0x537 << i;
    return ((data << 10) | d) ^ 0x5412;
  }
  function bchVersion(version) {       // BCH(18,6)
    var d = version << 12;
    for (var i = 5; i >= 0; i--) if ((d >>> (i + 12)) & 1) d ^= 0x1f25 << i;
    return (version << 12) | d;
  }

  /* format তথ্য দু'বার বসে — একবার বাঁ-উপরের finder ঘিরে, আরেকবার বাকি দুই
     finder-এর পাশে। খাড়া কপিটা ৮ নম্বর কলামে, শোয়ানো কপিটা ৮ নম্বর সারিতে।
     ৬ নম্বর সারি ও কলাম timing নকশার, তাই সেগুলো এড়িয়ে যেতে হয় — সেজন্যই
     মাঝপথে সূচকে এই লাফগুলো। */
  function placeFormat(m, ecl, mask) {
    var size = m.length;
    var bits = bchFormat((ECL_BITS[ecl] << 3) | mask);
    for (var i = 0; i < 15; i++) {
      var bit = (bits >>> i) & 1;
      // খাড়া কপি — ৮ নম্বর কলাম
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;
      // শোয়ানো কপি — ৮ নম্বর সারি
      if (i < 8) m[8][size - 1 - i] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
    }
    m[size - 8][8] = 1;   // সবসময় কালো থাকে এমন ঘরটা
  }

  function placeVersion(m, version) {
    if (version < 7) return;
    var size = m.length;
    var bits = bchVersion(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >>> i) & 1;
      var r = Math.floor(i / 3), c = i % 3;
      m[size - 11 + c][r] = bit;
      m[r][size - 11 + c] = bit;
    }
  }

  function encode(text, opts) {
    opts = opts || {};
    var ecl = opts.ecl || "M";
    if (!EC_TABLE[ecl]) throw new Error("QR: অজানা error correction level " + ecl);

    var version = opts.version || 0, cw = null, v;
    if (version) {
      cw = buildCodewords(text, version, ecl);
      if (!cw) throw new Error("QR: লেখাটা ভার্সন " + version + "-এ ধরবে না");
    } else {
      for (v = 1; v <= MAX_VERSION; v++) {
        cw = buildCodewords(text, v, ecl);
        if (cw) { version = v; break; }
      }
      if (!cw) throw new Error("QR: লেখাটা খুব বড় (সর্বোচ্চ ভার্সন " + MAX_VERSION + ")");
    }

    var bytes = interleave(cw, version, ecl);
    var size = version * 4 + 17;

    // কোন ঘরগুলো নকশার (ডেটা বসানো যাবে না) — আলাদা করে মনে রাখা
    var base = newMatrix(size);
    placeFinder(base, 0, 0);
    placeFinder(base, 0, size - 7);
    placeFinder(base, size - 7, 0);
    placeAlignment(base, version);
    placeTiming(base);
    reserveInfo(base, version);

    var reserved = [];
    for (var r = 0; r < size; r++) {
      reserved.push(new Int8Array(size));
      for (var c = 0; c < size; c++) reserved[r][c] = (base[r][c] === -1) ? 0 : 1;
    }

    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var m = [];
      for (r = 0; r < size; r++) m.push(Int8Array.from(base[r]));
      placeData(m, reserved, bytes);
      for (r = 0; r < size; r++) {
        for (c = 0; c < size; c++) {
          if (!reserved[r][c] && maskFn(mask, r, c)) m[r][c] ^= 1;
        }
      }
      placeFormat(m, ecl, mask);
      placeVersion(m, version);
      var p = penalty(m);
      if (!best || p < best.penalty) best = { matrix: m, penalty: p, mask: mask };
    }

    return {
      size: size,
      version: version,
      ecl: ecl,
      mask: best.mask,
      get: function (row, col) { return best.matrix[row][col] === 1; },
      matrix: best.matrix
    };
  }

  function toCanvas(canvas, text, opts) {
    opts = opts || {};
    var q = (text && text.size) ? text : encode(text, opts);
    var scale = opts.scale || 4;
    var margin = (opts.margin == null) ? 4 : opts.margin;
    var dim = (q.size + margin * 2) * scale;
    canvas.width = dim; canvas.height = dim;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = opts.light || "#ffffff";
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || "#000000";
    for (var r = 0; r < q.size; r++) {
      for (var c = 0; c < q.size; c++) {
        if (q.get(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
      }
    }
    return canvas;
  }

  function toDataURL(text, opts) {
    var canvas = document.createElement("canvas");
    toCanvas(canvas, text, opts);
    return canvas.toDataURL("image/png");
  }

  root.HBQR = { encode: encode, toCanvas: toCanvas, toDataURL: toDataURL, MAX_VERSION: MAX_VERSION };
})(typeof window !== "undefined" ? window : globalThis);
