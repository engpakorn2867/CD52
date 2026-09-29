// แบบจำลองการไหลของน้ำท่วมบนพื้นผิว 2 มิติ (local inertial / LISFLOOD-FP, Bates et al. 2010)
//
// ต่อยอดจากผลแบบ "อ่างน้ำ" ใน flood.js: ใช้ขอบเขตเสี่ยงสูงสุดเป็นโดเมนคำนวณ และจุดน้ำล้นตลิ่งเป็นจุดปล่อยน้ำ
// ปริมาณน้ำที่ล้น = Q − Q ตลิ่งเต็ม (ลบ.ม./วินาที) แบ่งตามความสูงที่น้ำเกินตลิ่งยกกำลัง 1.5 (สมการฝาย)
// ได้ผลตามเวลา: ความลึก ความเร็ว ทิศทางการไหล เวลาที่น้ำมาถึง
// แล้วคำนวณระดับอันตราย (Defra/EA FD2320: HR = d(v+0.5)+DF) และความเสียหายตามการใช้ที่ดิน
(function (root) {
  var G = 9.81;
  var FM = root.FloodModel || (typeof require !== 'undefined' ? require('./flood.js') : null);

  // ---------- ค่าคงที่ตามการใช้ที่ดิน (ESA WorldCover) ----------
  // รหัส: 1 ไม้ยืนต้น/สวน, 2 ไม้พุ่ม, 3 ทุ่งหญ้า, 4 เกษตรกรรม, 5 สิ่งปลูกสร้าง, 6 โล่ง, 8 น้ำ, 9 ชุ่มน้ำ, 11 ป่าชายเลน
  var LANDUSE = {
    0: { name: 'ไม่มีข้อมูล', n: 0.05, group: 'other' },
    1: { name: 'สวน/ไม้ยืนต้น', n: 0.10, group: 'tree' },
    2: { name: 'ไม้พุ่ม', n: 0.07, group: 'other' },
    3: { name: 'ทุ่งหญ้า', n: 0.04, group: 'other' },
    4: { name: 'นาข้าว/พืชไร่', n: 0.05, group: 'crop' },
    5: { name: 'บ้านเรือน/สิ่งปลูกสร้าง', n: 0.10, group: 'built' },
    6: { name: 'พื้นที่โล่ง', n: 0.03, group: 'other' },
    7: { name: 'อื่นๆ', n: 0.03, group: 'other' },
    8: { name: 'แหล่งน้ำ', n: 0.03, group: 'water' },
    9: { name: 'พื้นที่ชุ่มน้ำ', n: 0.07, group: 'other' },
    10: { name: 'อื่นๆ', n: 0.05, group: 'other' },
    11: { name: 'ป่าชายเลน', n: 0.10, group: 'tree' }
  };

  // ฟังก์ชันความลึก–สัดส่วนความเสียหาย (รูปแบบตาม JRC global depth-damage functions, Huizinga et al. 2017 ภูมิภาคเอเชีย
  // ค่าโดยประมาณ) — ความลึก (ม.) → สัดส่วนความเสียหาย 0..1
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
    if (d >= DEPTHS[DEPTHS.length - 1]) return c[c.length - 1];
    for (var i = 1; i < DEPTHS.length; i++) {
      if (d <= DEPTHS[i]) {
        var t = (d - DEPTHS[i - 1]) / (DEPTHS[i] - DEPTHS[i - 1]);
        return c[i - 1] + t * (c[i] - c[i - 1]);
      }
    }
    return c[c.length - 1];
  }

  // ระดับอันตรายต่อคน (UK Defra/Environment Agency FD2320)
  var HAZARD = [
    { max: 0.75, key: 'low', label: 'ต่ำ — ระวัง', desc: 'เดินลุยน้ำได้ด้วยความระมัดระวัง' },
    { max: 1.25, key: 'mod', label: 'ปานกลาง — อันตรายต่อเด็ก ผู้สูงอายุ ผู้ป่วย', desc: 'ไม่ควรเดินลุยน้ำ' },
    { max: 2.0, key: 'sig', label: 'สูง — อันตรายต่อคนส่วนใหญ่', desc: 'ควรอพยพ รถเล็กอาจลอย' },
    { max: Infinity, key: 'ext', label: 'รุนแรงมาก — อันตรายต่อทุกคน', desc: 'กระแสน้ำพัดคน/รถ อาคารอาจเสียหาย' }
  ];
  function hazardRating(d, v, group) {
    if (!(d > 0)) return 0;
    var df = d < 0.25 ? 0 : (group === 'built' || group === 'tree' ? 1 : 0.5);
    return d * (v + 0.5) + df;
  }
  function hazardClass(hr) {
    if (!(hr > 0)) return -1;
    for (var i = 0; i < HAZARD.length; i++) if (hr <= HAZARD[i].max) return i;
    return HAZARD.length - 1;
  }

  // ---------- เตรียมการจำลอง ----------
  // grid: ตาราง DEM ละเอียด, bath: ผลจาก FloodModel.simulate (ขอบเขตเสี่ยงสูงสุด)
  // landuse: Uint8Array ขนาดเท่า grid (หรือ null)
  // opts: { inflowQ, durationH, demOffsetM, maxCells, snapshotMin, waterBodyDepthM }
  // ตัวแปรสถานะทั้งหมดเก็บแบบบีบอัดเฉพาะเซลล์ที่ใช้งาน (index 0..nc-1)
  function setup(grid, bath, landuse, opts) {
    var fw = grid.w, fh = grid.h, off = opts.demOffsetM || 0;
    var dist = bath.dist, chan = bath.chan, excess = bath.excess, wsFine = bath.ws;
    var wbd = opts.waterBodyDepthM == null ? 4 : opts.waterBodyDepthM;

    // โดเมนละเอียด: เซลล์ที่น้ำเข้าถึงได้ในแบบอ่างน้ำ (ไม่รวมตัวแม่น้ำ)
    var nDomain = 0;
    for (var k = 0; k < fw * fh; k++) if (dist[k] !== 65535 && chan[k] < 0) nDomain++;
    var f = 1, maxCells = opts.maxCells || 15000;
    while (nDomain / (f * f) > maxCells && f < 8) f++;

    var W = Math.ceil(fw / f), H = Math.ceil(fh / f), N = W * H;
    var zSum = new Float64Array(N), nSum = new Float64Array(N), cnt = new Uint16Array(N);
    var wsMax = new Float32Array(N), inW = new Float64Array(N), inWs = new Float32Array(N);
    for (var fy = 0; fy < fh; fy++) for (var fx = 0; fx < fw; fx++) {
      var fk = fy * fw + fx;
      if (dist[fk] === 65535 || chan[fk] >= 0) continue;
      var e = grid.elev[fk];
      if (!(e === e)) continue;
      var ck = ((fy / f) | 0) * W + ((fx / f) | 0);
      zSum[ck] += e - off;
      nSum[ck] += (LANDUSE[landuse ? landuse[fk] : 4] || LANDUSE[0]).n;
      cnt[ck]++;
      if (wsFine[fk] > wsMax[ck]) wsMax[ck] = wsFine[fk];
      // เซลล์ติดตลิ่งที่น้ำล้นเข้ามา: น้ำหนักตามสมการฝาย (ความสูงเกินตลิ่ง)^1.5
      if (dist[fk] === 1) {
        var best = 0;
        for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
          var nx = fx + ox, ny = fy + oy;
          if (nx < 0 || ny < 0 || nx >= fw || ny >= fh) continue;
          var nk = ny * fw + nx;
          if (chan[nk] >= 0 && excess[nk] > best) best = excess[nk];
        }
        if (best > 0) {
          inW[ck] += Math.pow(best, 1.5);
          if (wsFine[fk] > inWs[ck]) inWs[ck] = wsFine[fk];
        }
      }
    }
    var idx = new Int32Array(N).fill(-1), cells = [];
    for (var c = 0; c < N; c++) if (cnt[c]) { idx[c] = cells.length; cells.push(c); }
    var nc = cells.length;
    var z = new Float32Array(nc), n2 = new Float32Array(nc);
    for (var a = 0; a < nc; a++) {
      var g0 = cells[a];
      // แอ่งลึก (บ่อ/ลำน้ำเดิม/ค่าผิดพลาด DEM) ถือว่ามีน้ำเต็มอยู่แล้ว: ยกพื้นขึ้นมาไม่เกิน wbd ใต้ระดับน้ำท่วม
      z[a] = Math.max(zSum[g0] / cnt[g0], wsMax[g0] - wbd);
      var nn = nSum[g0] / cnt[g0];
      n2[a] = nn * nn;
    }
    var inflow = [], inflowW = [], inflowWs = [], wTot = 0;
    for (a = 0; a < nc; a++) if (inW[cells[a]] > 0) { inflow.push(a); inflowW.push(inW[cells[a]]); inflowWs.push(inWs[cells[a]]); wTot += inW[cells[a]]; }
    for (var j = 0; j < inflowW.length; j++) inflowW[j] /= wTot || 1;

    // หน้าตัดระหว่างเซลล์ที่ใช้งานทั้งสองฝั่ง: x (ซ้าย→ขวา), y (บน→ล่าง)
    var xa = [], xb = [], ya = [], yb = [];
    for (a = 0; a < nc; a++) {
      var gc = cells[a], cx = gc % W;
      if (cx + 1 < W && idx[gc + 1] >= 0) { xa.push(a); xb.push(idx[gc + 1]); }
      if (gc + W < N && idx[gc + W] >= 0) { ya.push(a); yb.push(idx[gc + W]); }
    }

    var midLat = FM.yToLat(grid.y0 + fh / 2, grid.z);
    var dx = FM.metersPerPixel(midLat, grid.z) * f;

    return {
      f: f, W: W, H: H, N: N, nc: nc, dx: dx, grid: grid, bath: bath, landuse: landuse,
      cells: Int32Array.from(cells), idx: idx, z: z, n2: n2,
      xa: Int32Array.from(xa), xb: Int32Array.from(xb), ya: Int32Array.from(ya), yb: Int32Array.from(yb),
      qx: new Float32Array(xa.length), qy: new Float32Array(ya.length),
      h: new Float32Array(nc), hmax: new Float32Array(nc), vmax: new Float32Array(nc),
      vxAtMax: new Float32Array(nc), vyAtMax: new Float32Array(nc),
      tArrive: new Float32Array(nc).fill(-1), wet: new Float32Array(nc),
      sx: new Float32Array(nc), sy: new Float32Array(nc), cx: new Uint8Array(nc), cy: new Uint8Array(nc),
      inflow: Int32Array.from(inflow), inflowW: Float64Array.from(inflowW), inflowWs: Float32Array.from(inflowWs),
      Q: Math.max(0, opts.inflowQ || 0), T: (opts.durationH || 48) * 3600,
      t: 0, lastRec: 0, steps: 0, volIn: 0, volLost: 0, done: false,
      snapEvery: (opts.snapshotMin || 60) * 60, nextSnap: 0, snapshots: [],
      waterBodyDepthM: wbd, demOffsetM: off,
      zSmooth: smoothElev(grid)
    };
  }

  // DEM เฉลี่ย 3×3 สำหรับย่อผลลงตารางละเอียด (ลดจุดกระพริบจากค่า DEM เป็นจำนวนเต็มเมตร)
  function smoothElev(grid) {
    if (grid._smooth) return grid._smooth;
    var w = grid.w, h = grid.h, e = grid.elev, out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var sum = 0, n = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        var v = e[Y * w + X];
        if (v === v) { sum += v; n++; }
      }
      out[y * w + x] = n ? sum / n : NaN;
    }
    grid._smooth = out;
    return out;
  }

  // ---------- เดินเวลา ----------
  // วนคำนวณจนครบเวลา หรือใช้เวลาจริงเกิน budgetMs; คืน true เมื่อเสร็จ
  function run(s, budgetMs) {
    var t0 = Date.now();
    var nc = s.nc, dx = s.dx, z = s.z, h = s.h, n2 = s.n2;
    var xa = s.xa, xb = s.xb, ya = s.ya, yb = s.yb, qx = s.qx, qy = s.qy;
    var dx2 = dx * dx, HMIN = 0.001, WET = 0.05;
    while (!s.done) {
      // ก้าวเวลาแบบปรับได้ (CFL, alpha = 0.7)
      var hm = 0.1;
      for (var a = 0; a < nc; a++) if (h[a] > hm) hm = h[a];
      var dt = Math.min(60, 0.7 * dx / Math.sqrt(G * hm));
      if (s.t + dt > s.T) dt = s.T - s.t;
      if (dt <= 1e-6) { s.done = true; break; }

      // ฟลักซ์ต่อหน่วยความกว้าง (ม.²/วินาที) ที่หน้าตัด
      for (var i = 0; i < xa.length; i++) {
        var p = xa[i], r = xb[i];
        qx[i] = faceFlux(qx[i], z[p], h[p], z[r], h[r], (n2[p] + n2[r]) / 2, dt, dx, HMIN);
      }
      for (i = 0; i < ya.length; i++) {
        p = ya[i]; r = yb[i];
        qy[i] = faceFlux(qy[i], z[p], h[p], z[r], h[r], (n2[p] + n2[r]) / 2, dt, dx, HMIN);
      }
      // ความต่อเนื่อง
      var fac = dt / dx;
      for (i = 0; i < xa.length; i++) { var q = qx[i] * fac; h[xa[i]] -= q; h[xb[i]] += q; }
      for (i = 0; i < ya.length; i++) { q = qy[i] * fac; h[ya[i]] -= q; h[yb[i]] += q; }
      // น้ำล้นตลิ่งเข้าสู่พื้นที่ (ปิดจุดที่ระดับน้ำบนตลิ่งเท่าระดับแม่น้ำแล้ว)
      if (s.Q > 0 && s.inflow.length) {
        var open = 0, inf = s.inflow;
        for (var m = 0; m < inf.length; m++) if (z[inf[m]] + h[inf[m]] < s.inflowWs[m]) open += s.inflowW[m];
        if (open > 0) {
          var add = s.Q * dt / dx2 / open;
          for (m = 0; m < inf.length; m++) if (z[inf[m]] + h[inf[m]] < s.inflowWs[m]) h[inf[m]] += add * s.inflowW[m];
          s.volIn += s.Q * dt;
        } else s.volLost += s.Q * dt;
      }
      s.t += dt; s.steps++;

      // บันทึกค่าสูงสุด ความเร็ว เวลาที่น้ำมาถึง (ทุก 5 ก้าว)
      if (s.steps % 5 === 0 || s.t >= s.T) record(s, WET);
      if (s.t >= s.nextSnap || s.t >= s.T) {
        s.snapshots.push({ t: s.t, h: Float32Array.from(h) });
        s.nextSnap += s.snapEvery;
      }
      if (s.t >= s.T) { s.done = true; break; }
      if (Date.now() - t0 > budgetMs) break;
    }
    return s.done;
  }

  function record(s, WET) {
    var h = s.h, nc = s.nc, span = s.t - s.lastRec;
    s.lastRec = s.t;
    var sx = s.sx, sy = s.sy, cx = s.cx, cy = s.cy;
    sx.fill(0); sy.fill(0); cx.fill(0); cy.fill(0);
    for (var i = 0; i < s.xa.length; i++) { var q = s.qx[i]; sx[s.xa[i]] += q; cx[s.xa[i]]++; sx[s.xb[i]] += q; cx[s.xb[i]]++; }
    for (i = 0; i < s.ya.length; i++) { q = s.qy[i]; sy[s.ya[i]] += q; cy[s.ya[i]]++; sy[s.yb[i]] += q; cy[s.yb[i]]++; }
    for (var a = 0; a < nc; a++) {
      if (h[a] < 0) h[a] = 0;
      var d = h[a];
      if (d > s.hmax[a]) s.hmax[a] = d;
      if (d <= WET) continue;
      if (s.tArrive[a] < 0) s.tArrive[a] = s.t;
      s.wet[a] += span;
      // ความเร็วที่ศูนย์กลางเซลล์ (แกน y ชี้ลงใต้)
      var vx = cx[a] ? sx[a] / cx[a] / d : 0, vy = cy[a] ? sy[a] / cy[a] / d : 0;
      var v = Math.sqrt(vx * vx + vy * vy);
      if (v > s.vmax[a]) { s.vmax[a] = v; s.vxAtMax[a] = vx; s.vyAtMax[a] = vy; }
    }
  }

  function faceFlux(q, z1, h1, z2, h2, n2, dt, dx, HMIN) {
    var e1 = z1 + h1, e2 = z2 + h2;
    var hf = Math.max(e1, e2) - Math.max(z1, z2);
    if (hf <= HMIN) return 0;
    var S = (e2 - e1) / dx;
    var qn = (q - G * hf * dt * S) / (1 + G * dt * n2 * Math.abs(q) / Math.pow(hf, 7 / 3));
    // จำกัด Froude ≤ 1 เพื่อเสถียรภาพ และไม่ให้ดึงน้ำเกินที่มีในเซลล์ต้นทาง
    var lim = hf * Math.sqrt(G * hf);
    if (qn > lim) qn = lim; else if (qn < -lim) qn = -lim;
    var avail = (qn > 0 ? h1 : h2) * dx / (4 * dt);
    if (qn > avail) qn = avail; else if (qn < -avail) qn = -avail;
    return qn;
  }

  // ---------- ผลลัพธ์ระดับละเอียด ----------
  // ย่อระดับน้ำจากเซลล์หยาบลงสู่ DEM ละเอียด: ความลึก = ระดับผิวน้ำ − พื้นดินละเอียด
  // hArr: ความลึกแบบบีบอัด (ไม่ใส่ = ค่าสูงสุด) ใช้แสดงผลตามเวลา
  function fineDepth(s, hArr) {
    var g = s.grid, fw = g.w, fh = g.h, f = s.f, W = s.W, off = s.demOffsetM;
    var hc = hArr || s.hmax, out = new Float32Array(fw * fh);
    var dist = s.bath.dist, chan = s.bath.chan;
    for (var fy = 0; fy < fh; fy++) for (var fx = 0; fx < fw; fx++) {
      var fk = fy * fw + fx;
      if (dist[fk] === 65535 || chan[fk] >= 0) continue;
      var a = s.idx[((fy / f) | 0) * W + ((fx / f) | 0)];
      if (a < 0) continue;
      var hv = hc[a];
      if (!(hv > 0.02)) continue;
      var d = s.z[a] + hv - (s.zSmooth[fk] - off);
      if (d > 0 && d <= s.waterBodyDepthM) out[fk] = d;
    }
    return out;
  }

  // index ของเซลล์หยาบ (บีบอัด) สำหรับพิกเซลละเอียด
  function coarseOf(s, fx, fy) { return s.idx[((fy / s.f) | 0) * s.W + ((fx / s.f) | 0)]; }

  // สรุปผล: ระดับอันตราย ความเสียหาย ความเร็ว (บนตารางละเอียด)
  // values: { builtBahtPerM2, cropBahtPerRai, treeBahtPerRai, otherBahtPerRai, compensationBahtPerRai }
  function summarize(s, values) {
    var g = s.grid, fw = g.w, fh = g.h, f = s.f, W = s.W, M = FM;
    var depth = fineDepth(s);
    var hazard = new Uint8Array(fw * fh).fill(255), dmg = new Float32Array(fw * fh);
    var byHaz = HAZARD.map(function () { return 0; });
    var groups = { built: { area: 0, loss: 0 }, crop: { area: 0, loss: 0 }, tree: { area: 0, loss: 0 }, other: { area: 0, loss: 0 }, water: { area: 0, loss: 0 } };
    var area = 0, vmaxAll = 0, fast = 0, lossTotal = 0, cropRai = 0, collapse = 0, heavy = 0, vs = [];
    var perRai = { built: values.builtBahtPerM2 * 1600, crop: values.cropBahtPerRai, tree: values.treeBahtPerRai, other: values.otherBahtPerRai, water: 0 };
    for (var fy = 0; fy < fh; fy++) {
      var mpp = M.metersPerPixel(M.yToLat(g.y0 + fy + 0.5, g.z), g.z), a = mpp * mpp;
      for (var fx = 0; fx < fw; fx++) {
        var fk = fy * fw + fx, d = depth[fk];
        if (!(d > 0.02)) continue;
        var ck = coarseOf(s, fx, fy);
        var v = ck >= 0 ? s.vmax[ck] : 0;
        var lu = s.landuse ? s.landuse[fk] : 4, grp = (LANDUSE[lu] || LANDUSE[0]).group;
        var hr = hazardRating(d, v, grp), hc = hazardClass(hr);
        hazard[fk] = hc;
        byHaz[hc] += a;
        area += a;
        if (v > vmaxAll) vmaxAll = v;
        vs.push(v);
        if (v >= 1) fast += a;
        var frac = damageFraction(grp, d);
        // แรงปะทะของกระแสน้ำต่ออาคาร (Clausen & Clark 1990): d·v ≥ 3 เสียหายหนัก, ≥ 7 พังทลาย
        if (grp === 'built') {
          var dv = d * v;
          if (dv >= 7) { frac = 1; collapse += a; heavy += a; } else if (dv >= 3) { frac = Math.max(frac, 0.6); heavy += a; }
        }
        var loss = frac * perRai[grp] * a / 1600;
        dmg[fk] = loss / a; // บาท/ตร.ม.
        groups[grp].area += a; groups[grp].loss += loss;
        lossTotal += loss;
        if (grp === 'crop') cropRai += a / 1600;
      }
    }
    return {
      depth: depth, hazard: hazard, damagePerM2: dmg,
      areaRai: area / 1600, areaKm2: area / 1e6,
      hazardRai: byHaz.map(function (x) { return x / 1600; }),
      groups: groups, lossBaht: lossTotal, compensationBaht: cropRai * values.compensationBahtPerRai,
      vmax: vmaxAll, v99: percentile(vs, 0.99), fastRai: fast / 1600, collapseRai: collapse / 1600, heavyBuiltRai: heavy / 1600,
      volInM3: s.volIn, volLostM3: s.volLost
    };
  }

  function percentile(arr, p) {
    if (!arr.length) return 0;
    var a = Float32Array.from(arr).sort();
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }

  // ค่าที่จุด (lat, lon)
  function probe(s, sum, lat, lon) {
    var g = s.grid, p = FM.latLonToGrid(g, lat, lon);
    var fx = Math.floor(p[0]), fy = Math.floor(p[1]);
    if (fx < 0 || fy < 0 || fx >= g.w || fy >= g.h) return null;
    var fk = fy * g.w + fx, ck = coarseOf(s, fx, fy);
    if (ck < 0) return { depth: 0, v: 0, tArrive: -1, hazard: -1, damagePerM2: 0, wetH: 0,
      landuse: s.landuse ? (LANDUSE[s.landuse[fk]] || LANDUSE[0]).name : '' };
    return {
      depth: sum.depth[fk], v: s.vmax[ck], vx: s.vxAtMax[ck], vy: s.vyAtMax[ck],
      tArrive: s.tArrive[ck], wetH: s.wet[ck] / 3600,
      hazard: sum.hazard[fk] === 255 ? -1 : sum.hazard[fk], damagePerM2: sum.damagePerM2[fk],
      landuse: s.landuse ? (LANDUSE[s.landuse[fk]] || LANDUSE[0]).name : ''
    };
  }

  var api = {
    LANDUSE: LANDUSE, HAZARD: HAZARD, CURVES: CURVES, DEPTHS: DEPTHS,
    damageFraction: damageFraction, hazardRating: hazardRating, hazardClass: hazardClass,
    setup: setup, run: run, fineDepth: fineDepth, coarseOf: coarseOf, summarize: summarize, probe: probe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hydro = api;
})(this);
