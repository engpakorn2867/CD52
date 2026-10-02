'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../js/access.js');

// ถนนสมมติ: สายหลัก (แห้ง) → ซอย → หมู่บ้าน, ซอยมีช่วงน้ำท่วมกลางทาง · พิกัดเข้ารหัสแบบ delta ×1e5
const q = 100000;
function line(pts) { const out = []; let x = 0, y = 0; pts.forEach(([lon, lat]) => { const X = Math.round(lon * q), Y = Math.round(lat * q); out.push(X - x, Y - y); x = X; y = Y; }); return out; }
const basemap = { q, roads: {
  major: [line([[99.80, 13.80], [99.81, 13.80]])],
  secondary: [], tertiary: [],
  minor: [line([[99.81, 13.80], [99.815, 13.80], [99.82, 13.80]]), line([[99.8301, 13.80], [99.84, 13.80]])]   // เส้นที่สองขาด 1 กม. (ไม่ต่อ)
} };

test('กราฟถนน: ต่อปลายถนน และคำนวณการไปถึงตามความลึก', () => {
  const g = A.buildGraph(basemap);
  assert.ok(g.n >= 5 && g.m >= 4);
  const flood = (lon) => (lon > 99.812 && lon < 99.818 ? 0.6 : 0);   // ซอยช่วงกลางลึก 0.6 ม.
  const vehicles = A.VEHICLES.map((v, i) => Object.assign({}, v, { maxDepth: [0.3, 0.5, 0.8][i] }));
  const res = A.analyze(g, { depthAt: flood, vehicles, raise: [0, 0, 0, 0],
    villages: [{ key: 'ปลายซอย', lon: 99.82, lat: 13.80, depth: 0 }, { key: 'แยกขาด', lon: 99.84, lat: 13.80, depth: 0 }] });
  const v = Object.fromEntries(res.villages.map(x => [x.key, x.access.key]));
  assert.strictEqual(v['ปลายซอย'], 'truck', 'ลึก 0.6 ม. ผ่านได้เฉพาะรถยกสูง');
  assert.strictEqual(v['แยกขาด'], 'boat', 'ไม่มีถนนต่อเนื่อง');
  assert.ok(res.lenBy[2] > 0.5 && res.lenBy[2] < 1.2, String(res.lenBy[2]));   // 2 ช่วงถนน ~0.54 กม. ที่แตะช่วงน้ำท่วม
  // ยกผิวถนน 0.4 ม. → เหลือลึก 0.2 ม. รถเก๋งผ่านได้
  const res2 = A.analyze(g, { depthAt: flood, vehicles, raise: [0, 0, 0, 0.4], villages: [{ key: 'ปลายซอย', lon: 99.82, lat: 13.80, depth: 0 }] });
  assert.strictEqual(res2.villages[0].access.key, 'car');
});
