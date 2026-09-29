// ทดสอบแบบจำลองการไหล: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/flood.js');
const HY = require('../js/hydro.js');

// ที่ลุ่มลาดลงจากแม่น้ำ (ฝั่งเหนือ) ไปทางเหนือ: ใกล้ตลิ่ง 11 ม. ไกลออกไป 9 ม.
function setupCase(q, hours) {
  const z = 14, w = 120, h = 80;
  const x0 = Math.floor(M.lonToX(99.8, z)), y0 = Math.floor(M.latToY(13.8, z));
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) elev[y * w + x] = y < 60 ? 9 + (y / 60) * 2 : 13;
  const grid = { z, x0, y0, w, h, elev };
  const line = [M.gridLatLon(grid, 0, 62), M.gridLatLon(grid, w - 1, 62)];
  const river = M.rasterizeRiver(grid, line, 20);
  const profile = M.makeProfile([{ chainage: 0, ws: 11.9, leftBank: 11.73, rightBank: 11.81 }], 0);
  const bath = M.simulate(grid, river, profile, { demOffsetM: 0, maxSpreadKm: 50 });
  const s = HY.setup(grid, bath, null, { inflowQ: q, durationH: hours, maxCells: 100000, waterBodyDepthM: 10 });
  return { grid, bath, s };
}

test('การไหล: อนุรักษ์มวลน้ำ และน้ำไหลจากตลิ่งไปที่ต่ำ', () => {
  const { s } = setupCase(20, 6);
  assert.ok(s.inflow.length > 0, 'ต้องมีจุดน้ำล้นเข้า');
  HY.run(s, 1e9);
  assert.ok(s.done);
  let vol = 0;
  for (let a = 0; a < s.nc; a++) vol += s.h[a] * s.dx * s.dx;
  const vin = s.volIn;
  assert.ok(Math.abs(vol - vin) / vin < 1e-3, `มวลต้องคงที่ vol=${vol} in=${vin}`);
  // น้ำต้องไปถึงที่ลุ่มด้านเหนือ (y เล็ก) และลึกกว่าบริเวณใกล้ตลิ่ง
  const far = s.idx[5 * s.W + 60], near = s.idx[55 * s.W + 60];
  assert.ok(s.hmax[far] > s.hmax[near], 'ที่ต่ำต้องลึกกว่า');
  assert.ok(s.tArrive[far] > s.tArrive[near] || s.tArrive[near] >= 0, 'น้ำถึงตลิ่งก่อน');
  // ทิศทางการไหลหลักต้องไปทางเหนือ (vy < 0)
  const mid = s.idx[30 * s.W + 60];
  assert.ok(s.vyAtMax[mid] < 0, 'น้ำไหลไปทางเหนือ');
  const sum = HY.summarize(s, { builtBahtPerM2: 2500, cropBahtPerRai: 5500, treeBahtPerRai: 8000, otherBahtPerRai: 500, compensationBahtPerRai: 1340 });
  assert.ok(sum.areaRai > 0 && sum.lossBaht > 0);
  assert.ok(Math.abs(sum.hazardRai.reduce((a, b) => a + b, 0) - sum.areaRai) < 1e-6);
});

test('ไม่มีน้ำล้น → ไม่มีน้ำท่วม', () => {
  const { s } = setupCase(0, 3);
  HY.run(s, 1e9);
  assert.strictEqual(Math.max(...s.hmax), 0);
});

test('ระดับอันตราย Defra FD2320 และฟังก์ชันความเสียหาย', () => {
  // d=0.2, v=0.5 → 0.2 (ต่ำ); d=1, v=1, นา → 1.5+0.5 = 2.0 (สูง); d=1.5, v=1.5, เมือง → 3+1 = 4 (รุนแรงมาก)
  assert.strictEqual(HY.hazardClass(HY.hazardRating(0.2, 0.5, 'crop')), 0);
  assert.strictEqual(HY.hazardRating(1, 1, 'crop'), 2.0);
  assert.strictEqual(HY.hazardClass(2.0), 2);
  assert.strictEqual(HY.hazardClass(HY.hazardRating(1.5, 1.5, 'built')), 3);
  assert.strictEqual(HY.damageFraction('built', 0), 0);
  assert.ok(Math.abs(HY.damageFraction('built', 0.75) - 0.41) < 1e-9);
  assert.strictEqual(HY.damageFraction('built', 10), 1);
  for (const g of Object.keys(HY.CURVES)) {
    const c = HY.CURVES[g];
    for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1], g + ' ต้องไม่ลดลง');
  }
});
