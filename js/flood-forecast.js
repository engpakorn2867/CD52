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
    this.thr = new Float32Array(N); this.e = new Float32Array(N);
    this.tam = new Uint8Array(N); this.lu = new Uint8Array(N);
    for (var k = 0; k < N; k++) {
      var j = k * 4, t = a[j] * 256 + a[j + 1], ev = b[j] * 256 + b[j + 1];
      this.thr[k] = t === meta.none ? Infinity : t / sc - off;
      this.e[k] = ev === meta.none ? NaN : ev / sc - off;
      this.tam[k] = a[j + 2]; this.lu[k] = b[j + 2];
    }
    // พื้นที่เซลล์ (ตร.ม.) ตามละติจูดของแถว
    this.rowArea = new Float64Array(meta.h);
    for (var y = 0; y < meta.h; y++) {
      var n = Math.PI - 2 * Math.PI * (meta.y0 + y + 0.5) / (256 * Math.pow(2, meta.z));
      var lat = Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      var mpp = 40075016.686 * Math.cos(lat) / (256 * Math.pow(2, meta.z));
      this.rowArea[y] = mpp * mpp;
    }
    // เซลล์ที่น้ำอาจถึงได้ เรียงตาม thr (เร่งการคำนวณซ้ำ)
    var idx = [];
    for (k = 0; k < N; k++) if (this.thr[k] < 1e9 && this.e[k] === this.e[k]) idx.push(k);
    var thr = this.thr;
    idx.sort(function (p, q) { return thr[p] - thr[q]; });
    this.order = Int32Array.from(idx);
    // ระดับน้ำ K.55A ที่แต่ละตำบลเริ่มท่วม (พื้นที่ท่วมถึง ONSET_RAI ไร่)
    var maxD = meta.params.waterBodyDepthM || 4, acc = meta.tambons.map(function () { return 0; });
    this.onset = meta.tambons.map(function () { return null; });
    for (var i = 0; i < idx.length; i++) {
      k = idx[i];
      var ti = this.tam[k];
      if (ti === 255 || this.onset[ti] != null || this.thr[k] - this.e[k] > maxD || this.lu[k] === 8) continue;
      acc[ti] += this.rowArea[(k / meta.w) | 0] / 1600;
      if (acc[ti] >= ONSET_RAI) this.onset[ti] = Math.max(meta.bank, this.thr[k]);
    }
  }
  var ONSET_RAI = 50;

  Grid.prototype.dischargeFromLevel = function (h) { return interp(this.meta.ratingCurve, h, 1, 0); };
  Grid.prototype.levelFromDischarge = function (q) { return interp(this.meta.ratingCurve, q, 0, 1); };

  // ปริมาตรน้ำบนที่ราบ (ลบ.ม.) เมื่อระดับน้ำที่ K.55A = H และผิวน้ำในที่ลุ่มอยู่ที่ hv (≤ H)
  // เซลล์ที่น้ำไปถึงได้ (thr < H) รับน้ำจากที่ต่ำสุดขึ้นมาก่อน (น้ำล้นตลิ่งแล้วไหลลงไปขังในที่ลุ่ม)
  Grid.prototype.volumeAt = function (H, hv) {
    if (hv == null) hv = H;
    var o = this.order, thr = this.thr, e = this.e, lu = this.lu, w = this.meta.w, maxD = this.meta.params.waterBodyDepthM || 4, v = 0;
    for (var i = 0; i < o.length; i++) {
      var k = o[i];
      if (thr[k] >= H) break;
      if (thr[k] - e[k] > maxD || lu[k] === 8) continue;
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
      return { th: th, rai: 0, groups: { built: 0, crop: 0, tree: 0, other: 0 }, classes: [0, 0, 0, 0], damage: 0, sumD: 0, maxD: 0, meanD: 0, riskRai: 0 };
    }
    var tambons = m.tambons.map(blank), total = blank('รวม'), volume = 0;
    var o = this.order, thr = this.thr, e = this.e, lu = this.lu, tam = this.tam;
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
      var d = level - e[k];
      if (!(d > 0.02)) continue;
      depth[k] = d;
      var a = this.rowArea[(k / m.w) | 0];
      volume += d * a;
      var ti = tam[k];
      if (ti === 255) continue;
      var g = GROUP[lu[k]] || 'other', loss = damageFraction(g, d) * perM2[g] * a, rai = a / 1600, c = depthClass(d);
      [tambons[ti], total].forEach(function (s) {
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
      var c = CLASSES[depthClass(d)].color, j = k * 4;
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

  var api = { Grid: Grid, loadBrowser: loadBrowser, damageFraction: damageFraction, CLASSES: CLASSES, GROUP: GROUP, VALUES: VALUES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FloodForecast = api;
})(this);
