// คาดการณ์พื้นที่น้ำท่วม ความลึก และความเสียหาย รายตำบล อ.บ้านโป่ง จากระดับน้ำที่ K.55A
//
// ใช้ตารางที่คำนวณไว้ล่วงหน้า (data/banpong-flood.js, สร้างด้วย tools/build_flood_grid.js) ต่อเซลล์ ~37 ม.:
//   thr = ระดับน้ำ K.55A ต่ำสุดที่น้ำจากแนวตลิ่ง (9.00 ม.รทก. + ส่วนที่ตลิ่งเฉพาะที่สูงกว่า) ไหลมาถึงเซลล์ได้
//   e   = ระดับพื้นดินเทียบระดับน้ำ K.55A (ปรับความลาดผิวน้ำตามลำน้ำแล้ว)
// ระดับน้ำ H: เซลล์ท่วมเมื่อ thr < H ความลึก = H − e
// จำกัดตามปริมาตร: น้ำที่ล้น V = (Q − Q ตลิ่งเต็ม) × เวลา ไม่พอเติมทั้งพื้นที่ → หา “ระดับน้ำบนที่ราบ” h ≤ H
// ที่ปริมาตร Σ(h − e)·พื้นที่ = V (bisection)
(function (root) {
  // กลุ่มการใช้ที่ดิน (ESA WorldCover รหัสเดียวกับ js/hydro.js)
  var GROUP = { 1: 'tree', 2: 'tree', 3: 'other', 4: 'crop', 5: 'built', 6: 'other', 7: 'other', 8: 'water', 9: 'other', 10: 'other', 11: 'tree' };
  // ความลึก–สัดส่วนความเสียหาย (JRC, Huizinga et al. 2017 เอเชีย — ค่าเดียวกับ js/hydro.js)
  var DEPTHS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6];
  var CURVES = {
    built: [0, 0.33, 0.49, 0.62, 0.72, 0.87, 0.93, 0.98, 1],
    crop: [0, 0.14, 0.37, 0.52, 0.56, 0.66, 0.83, 0.99, 1],
    tree: [0, 0.08, 0.20, 0.33, 0.45, 0.62, 0.80, 0.95, 1],
    other: [0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60]
  };
  function damageFraction(group, d) {
    var c = CURVES[group];
    if (!c || !(d > 0)) return 0;
    for (var i = 1; i < DEPTHS.length; i++) {
      if (d <= DEPTHS[i]) return c[i - 1] + (d - DEPTHS[i - 1]) / (DEPTHS[i] - DEPTHS[i - 1]) * (c[i] - c[i - 1]);
    }
    return c[c.length - 1];
  }
  // ชั้นความลึก (ม.)
  var CLASSES = [
    { max: 0.5, label: '< 0.5 ม.', color: [158, 202, 225] },
    { max: 1, label: '0.5–1 ม.', color: [66, 146, 198] },
    { max: 2, label: '1–2 ม.', color: [33, 102, 172] },
    { max: Infinity, label: '> 2 ม.', color: [8, 48, 107] }
  ];
  // น้ำที่มาจากท่อระบายน้ำ/หนองบึง (โทนม่วง)
  var DRAIN_CLASSES = [[206, 147, 216], [171, 71, 188], [123, 31, 162], [74, 20, 140]];
  function depthClass(d) { for (var i = 0; i < CLASSES.length; i++) if (d < CLASSES[i].max) return i; return CLASSES.length - 1; }
  var VALUES = { builtBahtPerM2: 2500, cropBahtPerRai: 5500, treeBahtPerRai: 8000, otherBahtPerRai: 500 };

  function interp(curve, x, from, to) {
    var c = curve.slice().sort(function (a, b) { return a[from] - b[from]; }), n = c.length, i = 0;
    if (x >= c[n - 1][from]) i = n - 2;
    else while (i < n - 2 && x > c[i + 1][from]) i++;
    var a = c[i], b = c[i + 1];
    return a[to] + (x - a[from]) / (b[from] - a[from]) * (b[to] - a[to]);
  }

  // meta = window.BANPONG_FLOOD; a, b = ข้อมูล RGBA (Uint8) ของภาพ a และ b
  function Grid(meta, a, b) {
    var N = meta.w * meta.h, sc = meta.scale, off = meta.offset;
    this.meta = meta;
    this.thrBase = new Float32Array(N); this.eBase = new Float32Array(N);
    this.riverKey = new Float32Array(N).fill(Infinity);
    this.tam = new Uint8Array(N); this.lu = new Uint8Array(N);
    for (var k = 0; k < N; k++) {
      var j = k * 4, t = a[j] * 256 + a[j + 1], ev = b[j] * 256 + b[j + 1];
      this.tam[k] = a[j + 2]; this.lu[k] = b[j + 2];
      var tv = t === meta.none ? Infinity : t / sc - off;
      // เซลล์ลำน้ำเก็บระดับตลิ่งเฉพาะที่ (ข้อมูลรุ่น 2) — ใช้เป็นจุดเริ่มเมื่อคำนวณการแผ่ของน้ำใหม่
      if (this.lu[k] === meta.riverCode) { this.riverKey[k] = tv; tv = Infinity; }
      this.thrBase[k] = tv;
      this.eBase[k] = ev === meta.none ? NaN : ev / sc - off;
    }
    this.thr = this.thrBase; this.e = this.eBase;
    this.origin = new Uint8Array(N); // 0 = ล้นตลิ่ง, 1 = ท่อระบายน้ำ/หนองบึง
    this.dz = null;
    // พื้นที่เซลล์ (ตร.ม.) ตามละติจูดของแถว
    this.rowArea = new Float64Array(meta.h);
    for (var y = 0; y < meta.h; y++) {
      var n = Math.PI - 2 * Math.PI * (meta.y0 + y + 0.5) / (256 * Math.pow(2, meta.z));
      var lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      var mpp = 40075016.686 * Math.cos(lat) / (256 * Math.pow(2, meta.z));
      this.rowArea[y] = mpp * mpp;
    }
    this.mpp = Math.sqrt(this.rowArea[meta.h >> 1]);
    this._index();
  }

  // เรียงเซลล์ตาม thr (เร่งการคำนวณซ้ำ) และหาระดับน้ำที่แต่ละตำบลเริ่มท่วม (พื้นที่ท่วมถึง ONSET_RAI ไร่)
  Grid.prototype._index = function () {
    var meta = this.meta, N = meta.w * meta.h, thr = this.thr, e = this.e, idx = [];
    for (var k = 0; k < N; k++) if (thr[k] < 1e9 && e[k] === e[k]) idx.push(k);
    idx.sort(function (p, q) { return thr[p] - thr[q]; });
    this.order = Int32Array.from(idx);
    var maxD = meta.params.waterBodyDepthM || 4, acc = meta.tambons.map(function () { return 0; });
    this.onset = meta.tambons.map(function () { return null; });
    for (var i = 0; i < idx.length; i++) {
      k = idx[i];
      var ti = this.tam[k];
      if (ti === 255 || this.onset[ti] != null || thr[k] - e[k] > maxD || this.lu[k] === 8) continue;
      acc[ti] += this.rowArea[(k / meta.w) | 0] / 1600;
      if (acc[ti] >= ONSET_RAI) this.onset[ti] = Math.max(meta.bank, thr[k]);
    }
  };

  // ตำแหน่งเซลล์ของพิกัด (คืน -1 ถ้าอยู่นอกตาราง)
  Grid.prototype.cellOf = function (lon, lat) {
    var m = this.meta, n = 256 * Math.pow(2, m.z), r = lat * Math.PI / 180;
    var x = Math.floor((lon + 180) / 360 * n - m.x0), y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - m.y0);
    return x < 0 || y < 0 || x >= m.w || y >= m.h ? -1 : y * m.w + x;
  };
  Grid.prototype.groundAt = function (lon, lat) { var k = this.cellOf(lon, lat); return k < 0 ? NaN : this.e[k]; };

  // สถานการณ์เพิ่มเติม (คำนวณใหม่เมื่อเปลี่ยน ไม่ใช่ทุกครั้งที่ปรับระดับน้ำ):
  //   sources: จุดที่น้ำแม่น้ำเข้าพื้นที่ได้นอกเหนือจากข้ามตลิ่ง — ท่อระบายน้ำ/ประตูระบายน้ำที่ไม่มีบานกันน้ำย้อน, หนองบึงที่ต่อกับแม่น้ำ
  //            { lon, lat, level (ระดับท้องท่อ/ระดับที่น้ำเริ่มเข้า เทียบระดับ K.55A), radiusM (พื้นที่รับน้ำของท่อ) }
  //            น้ำย้อนท่อขึ้นมาที่ปากท่อ/บ่อพักทุกจุดในรัศมีเมื่อระดับน้ำ > max(ท้องท่อ, พื้นดิน) แล้วไหลต่อไปตามผิวดิน
  //   obs:     จุดน้ำท่วมที่วัดจริง { lon, lat, depth (ม., 0 = แห้ง), H (ระดับน้ำ K.55A ขณะวัด) } — ใช้ปรับระดับพื้นดินรอบจุด
  //            (DEM คลาดเคลื่อน ±0.5–1 ม.) ภายในรัศมี obsRadiusM แบบถ่วงน้ำหนัก
  Grid.prototype.setScenario = function (sc) {
    sc = sc || {};
    var m = this.meta, w = m.w, h = m.h, N = w * h, self = this;
    var sources = (sc.sources || []).filter(function (s) { return isFinite(s.level) && self.cellOf(s.lon, s.lat) >= 0; });
    var obs = (sc.obs || []).filter(function (o) { return isFinite(o.depth) && isFinite(o.H) && self.cellOf(o.lon, o.lat) >= 0; });
    this.scenario = { sources: sources.length, obs: obs.length };
    if (!sources.length && !obs.length) {
      this.thr = this.thrBase; this.e = this.eBase; this.origin = new Uint8Array(N); this.dz = null;
      this._index(); return this;
    }
    // 1) ปรับระดับพื้นดินจากข้อมูลหน้างาน
    var e = this.eBase;
    if (obs.length) {
      var R = sc.obsRadiusM || 1000, Rc = Math.ceil(3 * R / this.mpp), num = new Float32Array(N), den = new Float32Array(N);
      obs.forEach(function (o) {
        var k = self.cellOf(o.lon, o.lat), ox = k % w, oy = (k - ox) / w, ground = self.eBase[k], off;
        if (o.depth > 0) off = ground - (o.H - o.depth);           // น้ำลึก d ที่ระดับ H → พื้นดิน = H − d
        else if (ground < o.H) off = ground - (o.H + 0.05);        // จุดแห้งแต่แบบจำลองต่ำกว่าระดับน้ำ → ยกขึ้น
        else return;
        for (var y = Math.max(0, oy - Rc); y <= Math.min(h - 1, oy + Rc); y++) for (var x = Math.max(0, ox - Rc); x <= Math.min(w - 1, ox + Rc); x++) {
          var r = Math.hypot(x - ox, y - oy) * self.mpp / R, wt = Math.exp(-r * r);
          num[y * w + x] += wt * off; den[y * w + x] += wt;
        }
      });
      e = new Float32Array(this.eBase);
      this.dz = new Float32Array(N);
      for (var k = 0; k < N; k++) if (den[k] > 1e-4) { var d = num[k] / Math.max(1, den[k]); this.dz[k] = d; e[k] -= d; }
    } else this.dz = null;
    // 2) priority flood ใหม่: จากตลิ่ง (ช่วงที่ผ่าน อ.บ้านโป่ง) + จุดน้ำเข้าเพิ่มเติม
    var thr = new Float32Array(N).fill(Infinity), org = new Uint8Array(N), heap = new Heap(N), lu = this.lu, river = m.riverCode, dz = this.dz;
    // เซลล์ที่ไม่ถูกปรับพื้นดินใช้ค่าจากตารางเดิม (คิดเส้นทางน้ำนอกกรอบอำเภอไว้แล้ว) เป็นจุดเริ่ม
    for (k = 0; k < N; k++) {
      if (this.riverKey[k] < 1e9) heap.push(this.riverKey[k], k, 0);
      else if (this.thrBase[k] < 1e9 && !(dz && Math.abs(dz[k]) > 0.005)) { thr[k] = this.thrBase[k]; heap.push(thr[k], k, 0); }
    }
    // จุดที่สำรวจพบน้ำท่วม = หลักฐานว่าน้ำแม่น้ำเข้าถึงบริเวณนั้นได้ (เช่น ย้อนท่อ) → ใช้เป็นจุดน้ำเข้าในรัศมีของจุดสำรวจด้วย
    var R0 = sc.obsRadiusM || 1000;
    obs.forEach(function (o) { if (o.depth > 0) sources.push({ lon: o.lon, lat: o.lat, level: -100, radiusM: R0 }); });
    // จุดน้ำเข้าเพิ่มเติม: ป้าย 1..n = ลำดับจุด น้ำจากท่อแผ่ได้เฉพาะในรัศมีพื้นที่รับน้ำของท่อนั้น
    var src = sources.slice(0, 250).map(function (s) {
      var k0 = self.cellOf(s.lon, s.lat), sx = k0 % w;
      return { x: sx, y: (k0 - sx) / w, rc: Math.max(0, Math.round((s.radiusM || 0) / self.mpp)), level: s.level };
    });
    src.forEach(function (s, i) {
      for (var y = Math.max(0, s.y - s.rc); y <= Math.min(h - 1, s.y + s.rc); y++) for (var x = Math.max(0, s.x - s.rc); x <= Math.min(w - 1, s.x + s.rc); x++) {
        if ((x - s.x) * (x - s.x) + (y - s.y) * (y - s.y) > s.rc * s.rc) continue;
        var kk = y * w + x;
        if (lu[kk] === river || !(e[kk] === e[kk])) continue;
        var key = Math.max(s.level, e[kk]);
        if (key < thr[kk]) { thr[kk] = key; org[kk] = i + 1; heap.push(key, kk, i + 1); }
      }
    });
    var done = new Uint8Array(N);
    while (heap.n) {
      var c = heap.pop(), t = heap.lastKey, o = heap.lastTag;
      if (done[c] || t > thr[c] && lu[c] !== river) continue;
      done[c] = 1;
      var cx = c % w, cy = (c - cx) / w, so = o ? src[o - 1] : null;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var n = ny * w + nx;
        if (done[n] || lu[n] === river || !(e[n] === e[n])) continue;
        if (so && (nx - so.x) * (nx - so.x) + (ny - so.y) * (ny - so.y) > so.rc * so.rc) continue;
        var nt = Math.max(t, e[n]);
        if (nt < thr[n]) { thr[n] = nt; org[n] = o; heap.push(nt, n, o); }
      }
    }
    for (k = 0; k < N; k++) if (org[k]) org[k] = 1;
    this.thr = thr; this.e = e; this.origin = org;
    this._index();
    return this;
  };

  // ความลึกตามแบบจำลองที่จุดหนึ่ง เมื่อระดับน้ำ K.55A = H (ไม่จำกัดปริมาตร)
  Grid.prototype.depthAt = function (lon, lat, H) {
    var k = this.cellOf(lon, lat);
    if (k < 0 || !(this.thr[k] < H)) return 0;
    return Math.max(0, H - this.e[k]);
  };
  var ONSET_RAI = 50;

  // heap ค่าต่ำสุดก่อน (เก็บป้ายที่มาของน้ำด้วย)
  function Heap(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.g = new Uint8Array(n); this.n = 0; }
  Heap.prototype.push = function (key, val, tag) {
    if (this.n >= this.k.length) {
      var k2 = new Float64Array(this.k.length * 2), v2 = new Int32Array(this.k.length * 2), g2 = new Uint8Array(this.k.length * 2);
      k2.set(this.k); v2.set(this.v); g2.set(this.g); this.k = k2; this.v = v2; this.g = g2;
    }
    var i = this.n++, k = this.k, v = this.v, g = this.g;
    while (i > 0) { var p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; g[i] = g[p]; i = p; }
    k[i] = key; v[i] = val; g[i] = tag || 0;
  };
  Heap.prototype.pop = function () {
    var k = this.k, v = this.v, g = this.g, top = v[0];
    this.lastKey = k[0]; this.lastTag = g[0];
    var lk = k[--this.n], lv = v[this.n], lg = g[this.n], i = 0;
    for (;;) { var c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; g[i] = g[c]; i = c; }
    k[i] = lk; v[i] = lv; g[i] = lg;
    return top;
  };

  Grid.prototype.dischargeFromLevel = function (h) { return interp(this.meta.ratingCurve, h, 1, 0); };
  Grid.prototype.levelFromDischarge = function (q) { return interp(this.meta.ratingCurve, q, 0, 1); };

  // ปริมาตรน้ำบนที่ราบ (ลบ.ม.) เมื่อระดับน้ำที่ K.55A = H และผิวน้ำในที่ลุ่มอยู่ที่ hv (≤ H)
  // เซลล์ที่น้ำไปถึงได้ (thr < H) รับน้ำจากที่ต่ำสุดขึ้นมาก่อน (น้ำล้นตลิ่งแล้วไหลลงไปขังในที่ลุ่ม)
  Grid.prototype.volumeAt = function (H, hv) {
    if (hv == null) hv = H;
    var o = this.order, thr = this.thr, e = this.e, lu = this.lu, org = this.origin, w = this.meta.w, maxD = this.meta.params.waterBodyDepthM || 4, v = 0;
    for (var i = 0; i < o.length; i++) {
      var k = o[i];
      if (thr[k] >= H) break;
      if (thr[k] - e[k] > maxD || lu[k] === 8 || org[k] === 1) continue; // น้ำจากท่อไม่ใช้ปริมาตรน้ำล้นตลิ่ง
      var d = Math.min(hv, H) - e[k];
      if (d > 0) v += d * this.rowArea[(k / w) | 0];
    }
    return v;
  };

  // opts: { volumeM3 (จำกัดปริมาตร; ไม่ระบุ = ขอบเขตสูงสุดแบบอ่างน้ำ), values }
  Grid.prototype.compute = function (H, opts) {
    opts = opts || {};
    var m = this.meta, bank = m.bank, level = H, limited = false, vFull = 0;
    if (H > bank) {
      vFull = this.volumeAt(H);
      if (opts.volumeM3 != null && opts.volumeM3 < vFull) {
        var lo = bank - (m.params.waterBodyDepthM || 4), hi = H;
        for (var it = 0; it < 40; it++) { var mid = (lo + hi) / 2; if (this.volumeAt(H, mid) < opts.volumeM3) lo = mid; else hi = mid; }
        level = (lo + hi) / 2; limited = true;
      }
    }
    var val = Object.assign({}, VALUES, opts.values || {});
    var perM2 = { built: val.builtBahtPerM2, crop: val.cropBahtPerRai / 1600, tree: val.treeBahtPerRai / 1600, other: val.otherBahtPerRai / 1600 };
    var N = m.w * m.h, depth = new Float32Array(N), maxD = m.params.waterBodyDepthM || 4;
    function blank(th) {
      return { th: th, rai: 0, groups: { built: 0, crop: 0, tree: 0, other: 0 }, classes: [0, 0, 0, 0], damage: 0, sumD: 0, maxD: 0, meanD: 0, riskRai: 0, drainRai: 0 };
    }
    var tambons = m.tambons.map(blank), total = blank('รวม'), volume = 0;
    var o = this.order, thr = this.thr, e = this.e, lu = this.lu, tam = this.tam, org = this.origin;
    // แถบเสี่ยง: น้ำยังไม่ถึงแต่จะถึงถ้าระดับสูงขึ้นอีก riskM (ค่าความคลาดเคลื่อนของ DEM ~±0.5 ม.)
    var riskM = opts.riskM == null ? 0.5 : opts.riskM, risk = new Uint8Array(N);
    if (riskM > 0) for (var r = 0; r < o.length; r++) {
      var rk = o[r];
      if (thr[rk] < Math.max(H, bank)) continue;
      if (thr[rk] >= Math.max(H, bank) + riskM) break;
      if (thr[rk] - e[rk] > maxD || lu[rk] === 8) continue;
      risk[rk] = 1;
      var rr = this.rowArea[(rk / m.w) | 0] / 1600;
      if (tam[rk] !== 255) tambons[tam[rk]].riskRai += rr;
      total.riskRai += rr;
    }
    if (H > bank) for (var i = 0; i < o.length; i++) {
      var k = o[i];
      if (thr[k] >= H) break;
      if (thr[k] - e[k] > maxD || lu[k] === 8 || lu[k] === m.riverCode) continue;
      // น้ำย้อนท่อ: ผิวน้ำเท่าระดับแม่น้ำ (ท่อต่อตรงกับแม่น้ำ) ไม่ถูกจำกัดด้วยปริมาตรน้ำล้นตลิ่ง
      var d = (org[k] === 1 ? H : level) - e[k];
      if (!(d > 0.02)) continue;
      depth[k] = d;
      var a = this.rowArea[(k / m.w) | 0];
      if (org[k] !== 1) volume += d * a;
      var ti = tam[k];
      if (ti === 255) continue;
      var g = GROUP[lu[k]] || 'other', loss = damageFraction(g, d) * perM2[g] * a, rai = a / 1600, c = depthClass(d);
      var fromDrain = org[k] === 1;
      [tambons[ti], total].forEach(function (s) {
        if (fromDrain) s.drainRai += rai;
        s.rai += rai; s.groups[g] += rai; s.classes[c] += rai; s.damage += loss; s.sumD += d * rai; if (d > s.maxD) s.maxD = d;
      });
    }
    tambons.concat([total]).forEach(function (s) { s.meanD = s.rai ? s.sumD / s.rai : 0; });
    return {
      H: H, level: level, limited: limited, bank: bank, excess: Math.max(0, H - bank),
      volumeUsed: volume, volumeFull: vFull, depth: depth, risk: risk, riskM: riskM, tambons: tambons, total: total, onset: this.onset
    };
  };

  // ภาพซ้อนความลึก (RGBA) สำหรับวาดบนแผนที่
  Grid.prototype.overlayRGBA = function (depth, alpha, risk) {
    var N = depth.length, out = new Uint8ClampedArray(N * 4), A = Math.round((alpha == null ? 0.75 : alpha) * 255);
    for (var k = 0; k < N; k++) {
      var d = depth[k];
      if (!(d > 0)) {
        if (risk && risk[k]) { out[k * 4] = 255; out[k * 4 + 1] = 152; out[k * 4 + 2] = 0; out[k * 4 + 3] = Math.round(A * 0.6); }
        continue;
      }
      var c = this.origin[k] === 1 ? DRAIN_CLASSES[depthClass(d)] : CLASSES[depthClass(d)].color, j = k * 4;
      out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; out[j + 3] = A;
    }
    return out;
  };

  // โหลดในเบราว์เซอร์: ถอดรหัส PNG ผ่าน canvas
  function loadBrowser(meta) {
    function px(src) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          var c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          var x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          res(x.getImageData(0, 0, img.width, img.height).data);
        };
        img.onerror = rej; img.src = src;
      });
    }
    return Promise.all([px(meta.a), px(meta.b)]).then(function (r) { return new Grid(meta, r[0], r[1]); });
  }

  var api = { Grid: Grid, loadBrowser: loadBrowser, damageFraction: damageFraction, CLASSES: CLASSES, DRAIN_CLASSES: DRAIN_CLASSES, GROUP: GROUP, VALUES: VALUES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FloodForecast = api;
})(this);
