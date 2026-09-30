// ปรับ DEM ดาวเทียมให้ใกล้ระดับพื้นดินจริง (bare-earth) ในเขตอาคารและต้นไม้
//
// DEM จาก SRTM/เรดาร์วัดถึงหลังคาอาคารและยอดไม้ ในตัวเมืองบ้านโป่งสูงกว่าที่โล่งรอบๆ ~4 ม.
// (อาคาร p50 15 ม. เทียบกับนา/ทุ่งหญ้า p50 11 ม.) ทำให้แบบจำลองเห็นตัวเมืองเป็น “เนิน” ที่น้ำไม่เข้า
//
// วิธี: หาค่ากลางความสูงของที่โล่ง (นา ทุ่งหญ้า พื้นที่โล่ง ชุ่มน้ำ) ในแต่ละบล็อก ~1 กม.
// เกลี่ยเป็นผิวต่อเนื่อง (bilinear) แล้วกดเซลล์อาคาร/ต้นไม้ให้ไม่สูงกว่า ผิวอ้างอิง + tolM
// (tolM เผื่อว่าชุมชนมักตั้งบนที่ดอนริมน้ำเล็กน้อย) — แนวคิดเดียวกับ FABDEM (Hawker et al. 2022) แบบย่อ
(function (root) {
  var OPEN = { 3: 1, 4: 1, 6: 1, 9: 1 };     // ทุ่งหญ้า เกษตร โล่ง ชุ่มน้ำ
  var COVERED = { 1: 1, 2: 1, 5: 1, 11: 1 };  // ไม้ยืนต้น ไม้พุ่ม อาคาร ป่าชายเลน

  function pct(a, p) {
    if (!a.length) return NaN;
    a.sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length * p)];
  }
  function median(a) { return pct(a, 0.5); }

  // grid: {w,h,elev,z,y0}, landuse: Uint8Array; opts: { blockPx, minOpen, tolM, maxDropM, refPct }
  // คืน Float32Array ใหม่ (ไม่แก้ grid.elev) และสถิติ
  function bareEarth(grid, landuse, opts) {
    opts = opts || {};
    var w = grid.w, h = grid.h, e = grid.elev;
    var B = opts.blockPx || 27, minOpen = opts.minOpen || 15, tol = opts.tolM == null ? 1 : opts.tolM;
    var maxDrop = opts.maxDropM == null ? 5 : opts.maxDropM; // ไม่เกินความสูงอาคาร/ต้นไม้ทั่วไป (ไม่กดภูเขา)
    var bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    var ref = new Float32Array(bw * bh).fill(NaN);
    var buf = [];
    for (var by = 0; by < bh; by++) for (var bx = 0; bx < bw; bx++) {
      buf.length = 0;
      for (var y = by * B; y < Math.min(h, (by + 1) * B); y++) for (var x = bx * B; x < Math.min(w, (bx + 1) * B); x++) {
        var k = y * w + x, v = e[k];
        if (OPEN[landuse[k]] && v === v) buf.push(v);
      }
      // ใช้เปอร์เซ็นไทล์ต่ำ (ค่าเริ่มต้น 30) เพราะที่โล่งในเขตเมืองก็ถูกอาคาร/ต้นไม้รอบข้างรบกวนค่าด้วย
      if (buf.length >= minOpen) ref[by * bw + bx] = pct(buf, opts.refPct == null ? 0.3 : opts.refPct);
    }
    // เติมบล็อกที่ไม่มีที่โล่งพอ (เช่น กลางเมือง) จากบล็อกข้างเคียง
    for (var pass = 0; pass < 50; pass++) {
      var missing = 0, next = Float32Array.from(ref);
      for (var i = 0; i < ref.length; i++) {
        if (ref[i] === ref[i]) continue;
        var cx = i % bw, cy = (i - cx) / bw, sum = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          var r = ref[ny * bw + nx];
          if (r === r) { sum += r; n++; }
        }
        if (n) next[i] = sum / n; else missing++;
      }
      ref = next;
      if (!missing) break;
    }
    var out = Float32Array.from(e), changed = 0, drop = 0;
    for (y = 0; y < h; y++) {
      var fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (x = 0; x < w; x++) {
        k = y * w + x;
        if (!COVERED[landuse[k]] || !(e[k] === e[k])) continue;
        var fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        var g = (ref[y0 * bw + x0] * (1 - tx) + ref[y0 * bw + x1] * tx) * (1 - ty) + (ref[y1 * bw + x0] * (1 - tx) + ref[y1 * bw + x1] * tx) * ty;
        if (!(g === g)) continue;
        var cap = Math.max(g + tol, e[k] - maxDrop);
        if (e[k] > cap) { out[k] = cap; changed++; drop += e[k] - cap; }
      }
    }
    return { elev: out, changed: changed, meanDropM: changed ? drop / changed : 0 };
  }

  // ปรับเทียบ DEM กับระดับตลิ่งที่สำรวจจริงที่สถานี: ที่ราบโล่งรอบสถานี (รัศมี radiusKm ไม่รวมร่องน้ำ)
  // ถือว่ามีค่ากลางเท่ากับ ระดับตลิ่ง + fieldRelM → offset = ค่ากลาง DEM − (ตลิ่ง + fieldRelM)
  // (offset บวก = DEM สูงกว่าจริง จะถูกลบออกทั้งพื้นที่)
  function calibrateOffset(grid, elev, landuse, chan, gx, gy, bank, opts) {
    opts = opts || {};
    var FM = root.FloodModel || (typeof require !== 'undefined' ? require('./flood.js') : null);
    var mpp = FM.metersPerPixel(FM.yToLat(grid.y0 + gy, grid.z), grid.z);
    var r = Math.round((opts.radiusKm || 2) * 1000 / mpp), buf = [];
    for (var y = Math.max(0, gy - r); y <= Math.min(grid.h - 1, gy + r); y++) {
      for (var x = Math.max(0, gx - r); x <= Math.min(grid.w - 1, gx + r); x++) {
        if ((x - gx) * (x - gx) + (y - gy) * (y - gy) > r * r) continue;
        var k = y * grid.w + x;
        if (chan && chan[k] >= 0) continue;
        if (OPEN[landuse[k]] && elev[k] === elev[k]) buf.push(elev[k]);
      }
    }
    var m = median(buf);
    return { offset: m - (bank + (opts.fieldRelM || 0)), fieldMedian: m, n: buf.length };
  }

  var api = { bareEarth: bareEarth, calibrateOffset: calibrateOffset, OPEN: OPEN, COVERED: COVERED };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Terrain = api;
})(this);
