// แบบจำลองการแพร่กระจายน้ำท่วม (Connected bathtub / Height-Above-Nearest-Drainage แบบง่าย)
//
// หลักการ:
//  1. ระดับน้ำ (ws) และระดับตลิ่ง (bank) ตามแนวลำน้ำ คำนวณจากจุดควบคุม (สถานี K.55A เป็นหลัก
//     และสถานีอื่นในราชบุรีถ้ามีข้อมูล) โดยประมาณค่าเชิงเส้นตามระยะทางลำน้ำ (chainage)
//     นอกช่วงสถานีใช้ความลาดชันผิวน้ำ (ม./กม.)
//  2. ช่วงลำน้ำที่ ws > ตลิ่งฝั่งนั้น จะเป็นจุดที่น้ำล้นออกไป (แยกฝั่งซ้าย/ขวา มองตามทิศน้ำไหล)
//  3. น้ำแพร่ออกไปยังพิกเซลที่ติดกัน (8 ทิศ) ตราบใดที่ระดับพื้นดิน < ระดับน้ำของจุดที่ล้น
//     และไม่เกินระยะแพร่กระจายสูงสุด — พิกเซลที่ต่ำแต่ไม่เชื่อมต่อกับน้ำจะไม่ถูกนับ
//
// ข้อจำกัด: ไม่คิดปริมาตรน้ำ/เวลา/คันกั้นน้ำที่ DEM มองไม่เห็น จึงเป็น "ขอบเขตเสี่ยงสูงสุด" ไม่ใช่ผลจำลองชลศาสตร์
(function (root) {
  var TILE = 256;
  var EARTH_M_PER_PX_Z0 = 156543.03392804097; // ที่เส้นศูนย์สูตร ซูม 0

  // ---------- Web Mercator ----------
  function lonToX(lon, z) { return (lon + 180) / 360 * TILE * Math.pow(2, z); }
  function latToY(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * TILE * Math.pow(2, z);
  }
  function xToLon(x, z) { return x / (TILE * Math.pow(2, z)) * 360 - 180; }
  function yToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (TILE * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }
  function metersPerPixel(lat, z) { return EARTH_M_PER_PX_Z0 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z); }

  function haversineKm(a, b) {
    var R = 6371.0088, toR = Math.PI / 180;
    var dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // grid: { z, x0, y0, w, h, elev: Float32Array } — x0,y0 เป็นพิกัดพิกเซลโลกของมุมซ้ายบน
  function gridLatLon(grid, gx, gy) {
    return [yToLat(grid.y0 + gy + 0.5, grid.z), xToLon(grid.x0 + gx + 0.5, grid.z)];
  }
  function latLonToGrid(grid, lat, lon) {
    return [lonToX(lon, grid.z) - grid.x0, latToY(lat, grid.z) - grid.y0];
  }

  // ---------- ลำน้ำ ----------
  // คืนค่า chainage สะสม (กม.) ของแต่ละจุดยอด
  function chainages(line) {
    var out = [0];
    for (var i = 1; i < line.length; i++) out.push(out[i - 1] + haversineKm(line[i - 1], line[i]));
    return out;
  }

  // ฉายจุดลงบนเส้นลำน้ำ → { chainage (กม.), distKm, lat, lon }
  function projectToLine(line, lat, lon) {
    var ch = chainages(line);
    var best = null;
    // ใช้ระบบพิกัดระนาบเฉพาะที่ (equirectangular) พอสำหรับระยะไม่กี่สิบกิโลเมตร
    var kx = 111.32 * Math.cos(lat * Math.PI / 180), ky = 110.57;
    for (var i = 0; i < line.length - 1; i++) {
      var ax = (line[i][1] - lon) * kx, ay = (line[i][0] - lat) * ky;
      var bx = (line[i + 1][1] - lon) * kx, by = (line[i + 1][0] - lat) * ky;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      var px = ax + t * dx, py = ay + t * dy;
      var d = Math.sqrt(px * px + py * py);
      if (!best || d < best.distKm) {
        best = {
          distKm: d,
          chainage: ch[i] + t * (ch[i + 1] - ch[i]),
          lat: line[i][0] + t * (line[i + 1][0] - line[i][0]),
          lon: line[i][1] + t * (line[i + 1][1] - line[i][1])
        };
      }
    }
    return best;
  }

  // ---------- โปรไฟล์ระดับน้ำ/ตลิ่งตามลำน้ำ ----------
  // controls: [{ chainage, ws, leftBank, rightBank }], slope: ม./กม. (ระดับลดลงตามทิศท้ายน้ำ)
  function makeProfile(controls, slope) {
    var c = controls.filter(function (p) { return isFinite(p.chainage); })
      .sort(function (a, b) { return a.chainage - b.chainage; });
    if (!c.some(function (p) { return isFinite(p.ws); })) throw new Error('ต้องมีจุดควบคุมระดับน้ำอย่างน้อย 1 จุด');
    function field(ch, key) {
      // เลือกเฉพาะจุดที่มีค่านั้น
      var pts = c.filter(function (p) { return isFinite(p[key]); });
      if (!pts.length) return NaN;
      if (ch <= pts[0].chainage) return pts[0][key] + slope * (pts[0].chainage - ch);
      var last = pts[pts.length - 1];
      if (ch >= last.chainage) return last[key] - slope * (ch - last.chainage);
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        if (ch <= b.chainage) {
          var t = (ch - a.chainage) / ((b.chainage - a.chainage) || 1);
          return a[key] + t * (b[key] - a[key]);
        }
      }
      return last[key];
    }
    return {
      ws: function (ch) { return field(ch, 'ws'); },
      leftBank: function (ch) { return field(ch, 'leftBank'); },
      rightBank: function (ch) { return field(ch, 'rightBank'); },
      controls: c
    };
  }

  // ---------- Raster ลำน้ำ ----------
  // คืน { chan: Int32Array (index ของจุดกึ่งกลางที่ใกล้ที่สุด หรือ -1), cl: [{gx,gy,ch,dx,dy}] }
  function rasterizeRiver(grid, line, halfWidthM) {
    var w = grid.w, h = grid.h, N = w * h;
    var ch = chainages(line);
    var cl = [];
    var seen = new Int32Array(N).fill(-1);
    for (var i = 0; i < line.length - 1; i++) {
      var a = latLonToGrid(grid, line[i][0], line[i][1]);
      var b = latLonToGrid(grid, line[i + 1][0], line[i + 1][1]);
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = Math.sqrt(dx * dx + dy * dy);
      var steps = Math.max(1, Math.ceil(len * 2));
      for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        var gx = Math.floor(a[0] + t * dx), gy = Math.floor(a[1] + t * dy);
        if (gx < 0 || gy < 0 || gx >= w || gy >= h) continue;
        var k = gy * w + gx;
        if (seen[k] >= 0) continue;
        seen[k] = cl.length;
        cl.push({ gx: gx, gy: gy, ch: ch[i] + t * (ch[i + 1] - ch[i]), dx: dx / (len || 1), dy: dy / (len || 1) });
      }
    }
    // ขยายเป็นร่องน้ำ: BFS จากเส้นกึ่งกลาง รับ index ของจุดกึ่งกลางต้นทาง
    var midLat = yToLat(grid.y0 + h / 2, grid.z);
    var rpx = halfWidthM / metersPerPixel(midLat, grid.z);
    var r2 = rpx * rpx;
    var chan = seen; // ใช้ array เดิม
    var q = new Int32Array(N), qh = 0, qt = 0;
    for (var j = 0; j < cl.length; j++) q[qt++] = cl[j].gy * w + cl[j].gx;
    while (qh < qt) {
      var cur = q[qh++];
      var src = cl[chan[cur]];
      var cx = cur % w, cy = (cur - cx) / w;
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        var nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var nk = ny * w + nx;
        if (chan[nk] >= 0) continue;
        var ex = nx - src.gx, ey = ny - src.gy;
        if (ex * ex + ey * ey > r2) continue;
        chan[nk] = chan[cur];
        q[qt++] = nk;
      }
    }
    return { chan: chan, cl: cl, rpx: rpx };
  }

  // ---------- ความสูงตลิ่งเฉพาะที่จาก DEM ----------
  // DEM ดาวเทียมมีค่าคลาดเคลื่อนสัมบูรณ์หลายเมตร (ต้นไม้/อาคาร) จึงใช้เฉพาะ "ส่วนเบี่ยงเบนเฉพาะที่"
  // ของตลิ่งแต่ละฝั่ง (ตัดแนวโน้มเชิงเส้นตามลำน้ำออก) ไปบวกกับระดับตลิ่งที่สำรวจจริงของ K.55A
  // → ช่วงที่ตลิ่งต่ำกว่าปกติจะล้นก่อน ช่วงที่เป็นเมือง/ที่ดอนจะล้นช้ากว่า
  // opts: { bandM: ความกว้างแถบตลิ่งที่สุ่มตัวอย่าง, smoothKm, clampM }
  function bankDeviation(grid, river, opts) {
    opts = opts || {};
    var bandM = opts.bandM || 300, smoothKm = opts.smoothKm || 1.5, clampM = opts.clampM == null ? 2 : opts.clampM;
    var cl = river.cl, n = cl.length, w = grid.w, h = grid.h, elev = grid.elev;
    var midLat = yToLat(grid.y0 + h / 2, grid.z), mpp = metersPerPixel(midLat, grid.z);
    var r0 = river.rpx + 1, r1 = river.rpx + Math.max(2, bandM / mpp);
    var raw = [new Float32Array(n), new Float32Array(n)]; // [ซ้าย, ขวา]
    var buf = [];
    for (var i = 0; i < n; i++) {
      var c = cl[i];
      for (var side = 0; side < 2; side++) {
        var sgn = side === 0 ? 1 : -1; // ซ้าย = (dy, -dx)
        var nx = sgn * c.dy, ny = -sgn * c.dx;
        buf.length = 0;
        for (var d = r0; d <= r1; d += 1) {
          var x = Math.floor(c.gx + 0.5 + nx * d), y = Math.floor(c.gy + 0.5 + ny * d);
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (river.chan[y * w + x] >= 0) continue;
          var e = elev[y * w + x];
          if (e === e) buf.push(e); // ข้าม NaN (ไม่มีข้อมูล)
        }
        buf.sort(function (a, b) { return a - b; });
        raw[side][i] = buf.length ? buf[Math.floor(buf.length / 2)] : NaN;
      }
    }
    var out = [];
    for (var sd = 0; sd < 2; sd++) {
      // ค่ากลางเคลื่อนที่ตามลำน้ำ (±smoothKm)
      var sm = new Float32Array(n), lo = 0, hi = 0, win = [];
      for (var j = 0; j < n; j++) {
        while (lo < n && cl[lo].ch < cl[j].ch - smoothKm) lo++;
        while (hi < n && cl[hi].ch <= cl[j].ch + smoothKm) hi++;
        win.length = 0;
        for (var t = lo; t < hi; t++) if (isFinite(raw[sd][t])) win.push(raw[sd][t]);
        win.sort(function (a, b) { return a - b; });
        sm[j] = win.length ? win[Math.floor(win.length / 2)] : NaN;
      }
      // ตัดแนวโน้มเชิงเส้น (least squares ตาม chainage)
      var sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
      for (var k = 0; k < n; k++) if (isFinite(sm[k])) { var X = cl[k].ch; sx += X; sy += sm[k]; sxx += X * X; sxy += X * sm[k]; cnt++; }
      var slope = cnt > 1 ? (cnt * sxy - sx * sy) / ((cnt * sxx - sx * sx) || 1) : 0;
      var icpt = cnt ? (sy - slope * sx) / cnt : 0;
      var dev = new Float32Array(n);
      for (var m = 0; m < n; m++) {
        var v = isFinite(sm[m]) ? sm[m] - (icpt + slope * cl[m].ch) : 0;
        dev[m] = Math.max(-clampM, Math.min(clampM, v));
      }
      out.push({ dev: dev, trendSlope: slope });
    }
    return { left: out[0].dev, right: out[1].dev, trendSlopeMPerKm: -(out[0].trendSlope + out[1].trendSlope) / 2 };
  }

  // ---------- จำลองน้ำท่วม ----------
  // opts: { demOffsetM, maxSpreadKm, volumeM3 (ปริมาตรน้ำที่ล้น; ไม่ใส่ = ไม่จำกัด),
  //         bankDev: ผลจาก bankDeviation(), bankDevWeight: 0..1,
  //         waterBodyDepthM: พิกเซลที่ลึกกว่านี้ถือเป็นแหล่งน้ำเดิม (บ่อ/ลำน้ำสาขา/ค่าผิดพลาด DEM) — น้ำผ่านได้แต่ไม่นับพื้นที่ }
  function simulate(grid, river, profile, opts) {
    var w = grid.w, h = grid.h, N = w * h, elev = grid.elev;
    var off = opts.demOffsetM || 0;
    var chan = river.chan, cl = river.cl;
    var depth = new Float32Array(N);
    var wsCell = new Float32Array(N);
    var excess = new Float32Array(N); // ความสูงที่น้ำเกินตลิ่ง ณ พิกเซลร่องน้ำที่ล้น
    var dist = new Uint16Array(N).fill(65535);
    var q = new Int32Array(N), qh = 0, qt = 0;

    // ค่า ws/ตลิ่ง ต่อจุดกึ่งกลางลำน้ำ (คำนวณครั้งเดียว)
    var clWs = new Float32Array(cl.length), clL = new Float32Array(cl.length), clR = new Float32Array(cl.length);
    for (var i = 0; i < cl.length; i++) {
      clWs[i] = profile.ws(cl[i].ch);
      var bw = opts.bankDev ? (opts.bankDevWeight == null ? 1 : opts.bankDevWeight) : 0;
      // ใช้เฉพาะส่วนที่ตลิ่งสูงกว่าแนวโน้ม: ถือว่าตลิ่งที่สำรวจของ K.55A เป็นระดับตลิ่งวิกฤต (ต่ำ) ของลำน้ำ
      // ช่วงที่ DEM ต่ำกว่าแนวโน้มมักเป็นสัญญาณรบกวน/ผิวน้ำ จึงไม่ลดตลิ่งลง
      clL[i] = profile.leftBank(cl[i].ch) + (bw ? bw * Math.max(0, opts.bankDev.left[i]) : 0);
      clR[i] = profile.rightBank(cl[i].ch) + (bw ? bw * Math.max(0, opts.bankDev.right[i]) : 0);
    }

    // จุดตั้งต้น: พิกเซลร่องน้ำที่อยู่ฝั่งที่น้ำล้นตลิ่ง
    var overflowLeft = 0, overflowRight = 0;
    var clOverflow = new Uint8Array(cl.length); // bit1 = ซ้าย, bit2 = ขวา
    for (var k = 0; k < N; k++) {
      var ci = chan[k];
      if (ci < 0) continue;
      var c = cl[ci];
      var kx = k % w, ky = (k - kx) / w;
      var ox = kx - c.gx, oy = ky - c.gy;
      // แกน y ของภาพชี้ลง: cross < 0 = ฝั่งซ้ายเมื่อมองตามทิศน้ำไหล
      var cross = c.dx * oy - c.dy * ox;
      var bank = cross < 0 ? clL[ci] : (cross > 0 ? clR[ci] : Math.min(clL[ci], clR[ci]));
      if (clWs[ci] > bank) {
        excess[k] = clWs[ci] - bank;
        wsCell[k] = clWs[ci];
        dist[k] = 0;
        q[qt++] = k;
        if (cross) clOverflow[ci] |= cross < 0 ? 1 : 2; // จุดบนเส้นกึ่งกลางไม่นับฝั่ง
      }
    }
    for (var m = 0; m < cl.length; m++) {
      if (clOverflow[m] & 1) overflowLeft++;
      if (clOverflow[m] & 2) overflowRight++;
    }

    var midLat = yToLat(grid.y0 + h / 2, grid.z);
    var maxSteps = Math.min(65534, Math.round(opts.maxSpreadKm * 1000 / metersPerPixel(midLat, grid.z)));
    var wbDepth = opts.waterBodyDepthM == null ? Infinity : opts.waterBodyDepthM;

    while (qh < qt) {
      var cur = q[qh++];
      var ws = wsCell[cur], d0 = dist[cur];
      if (d0 >= maxSteps) continue;
      var cx = cur % w, cy = (cur - cx) / w;
      for (var yy = -1; yy <= 1; yy++) for (var xx = -1; xx <= 1; xx++) {
        if (!xx && !yy) continue;
        var nx = cx + xx, ny = cy + yy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var nk = ny * w + nx;
        if (dist[nk] !== 65535 || chan[nk] >= 0) continue;
        var g = elev[nk] - off;
        if (!(g < ws)) continue;
        dist[nk] = d0 + 1;
        wsCell[nk] = ws;
        depth[nk] = ws - g > wbDepth ? 0 : ws - g;
        q[qt++] = nk;
      }
    }

    // จำกัดด้วยปริมาตรน้ำที่ล้นตลิ่ง: เติมน้ำตามลำดับการเข้าถึง (ใกล้ตลิ่งก่อน) จนครบปริมาตร
    var envelope = depth, pred = depth, volUsed = 0, limitSteps = maxSteps;
    var V = opts.volumeM3;
    if (V != null && isFinite(V)) {
      pred = new Float32Array(N);
      var rowArea = new Float64Array(h);
      for (var ry = 0; ry < h; ry++) { var mp = metersPerPixel(yToLat(grid.y0 + ry + 0.5, grid.z), grid.z); rowArea[ry] = mp * mp; }
      var qi = 0;
      for (; qi < qt; qi++) {
        var kk = q[qi];
        if (dist[kk] === 0) continue; // ร่องน้ำ
        var add = depth[kk] * rowArea[(kk - kk % w) / w];
        if (volUsed + add > V) break;
        volUsed += add;
        pred[kk] = depth[kk];
      }
      limitSteps = qi < qt ? dist[q[qi]] : maxSteps;
    }

    return {
      depth: pred, envelope: envelope, ws: wsCell, dist: dist, chan: chan, excess: excess,
      stats: computeStats(grid, pred, dist),
      envelopeStats: computeStats(grid, envelope, dist),
      volumeUsedM3: volUsed, volumeLimited: pred !== envelope, limitSteps: limitSteps,
      overflowKm: {
        left: overflowLeft * metersPerPixel(midLat, grid.z) / 1000,
        right: overflowRight * metersPerPixel(midLat, grid.z) / 1000
      },
      maxSteps: maxSteps,
      pxM: metersPerPixel(midLat, grid.z)
    };
  }

  var DEPTH_CLASSES = [
    { max: 0.5, label: '0–0.5 ม.' },
    { max: 1.0, label: '0.5–1 ม.' },
    { max: 2.0, label: '1–2 ม.' },
    { max: Infinity, label: '> 2 ม.' }
  ];

  function computeStats(grid, depth, dist) {
    var w = grid.w, h = grid.h;
    var areaM2 = 0, byClass = DEPTH_CLASSES.map(function () { return 0; });
    var maxDepth = 0, sumDepthArea = 0, maxDist = 0;
    for (var y = 0; y < h; y++) {
      var mpp = metersPerPixel(yToLat(grid.y0 + y + 0.5, grid.z), grid.z);
      var a = mpp * mpp;
      for (var x = 0; x < w; x++) {
        var k = y * w + x, d = depth[k];
        if (d <= 0) continue;
        areaM2 += a;
        sumDepthArea += d * a;
        if (d > maxDepth) maxDepth = d;
        if (dist[k] > maxDist) maxDist = dist[k];
        for (var c = 0; c < DEPTH_CLASSES.length; c++) if (d <= DEPTH_CLASSES[c].max) { byClass[c] += a; break; }
      }
    }
    return {
      areaKm2: areaM2 / 1e6,
      areaRai: areaM2 / 1600,
      byClassRai: byClass.map(function (v) { return v / 1600; }),
      classLabels: DEPTH_CLASSES.map(function (c) { return c.label; }),
      maxDepth: maxDepth,
      meanDepth: areaM2 ? sumDepthArea / areaM2 : 0,
      volumeMm3: sumDepthArea / 1e6,
      maxDistSteps: maxDist
    };
  }

  var api = {
    lonToX: lonToX, latToY: latToY, xToLon: xToLon, yToLat: yToLat,
    metersPerPixel: metersPerPixel, haversineKm: haversineKm,
    gridLatLon: gridLatLon, latLonToGrid: latLonToGrid,
    chainages: chainages, projectToLine: projectToLine, makeProfile: makeProfile,
    rasterizeRiver: rasterizeRiver, bankDeviation: bankDeviation, simulate: simulate, computeStats: computeStats,
    DEPTH_CLASSES: DEPTH_CLASSES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FloodModel = api;
})(this);
