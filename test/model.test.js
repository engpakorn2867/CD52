// ทดสอบ: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CFG = require('../js/config.js');
const R = require('../js/rating.js');
const M = require('../js/flood.js');
const TW = require('../js/thaiwater.js');

const curve = CFG.primaryStation.ratingCurve;

test('rating curve ตรงกับตารางของ K.55A', () => {
  for (const [q, h] of curve) {
    assert.ok(Math.abs(R.levelFromDischarge(curve, q) - h) < 1e-9);
    assert.ok(Math.abs(R.dischargeFromLevel(curve, h) - q) < 1e-6);
  }
  assert.ok(Math.abs(R.levelFromDischarge(curve, 3050) - 11.965) < 1e-9);
  // นอกช่วงตาราง: ใช้ความชันช่วงปลาย
  assert.ok(Math.abs(R.levelFromDischarge(curve, 3500) - 12.88) < 1e-9);
  assert.ok(Math.abs(R.levelFromDischarge(curve, 2800) - 11.44) < 1e-9);
});

test('สถานะตลิ่งตามภาพ: 2,900 ต่ำกว่าตลิ่ง, 2,950 ล้นตลิ่งซ้าย, 3,000 ล้นทั้งสองฝั่ง', () => {
  const { leftBank, rightBank } = CFG.primaryStation;
  assert.strictEqual(R.bankStatus(R.levelFromDischarge(curve, 2900), leftBank, rightBank).level, 0);
  const s2950 = R.bankStatus(R.levelFromDischarge(curve, 2950), leftBank, rightBank); // 11.755
  assert.strictEqual(s2950.level, 1);
  assert.strictEqual(s2950.label, 'ล้นตลิ่งซ้าย');
  // 11.86 สูงกว่าทั้งตลิ่งซ้าย 11.73 และขวา 11.81 (เส้นประแดงในภาพ)
  assert.strictEqual(R.bankStatus(R.levelFromDischarge(curve, 3000), leftBank, rightBank).level, 2);
});

test('โปรไฟล์ระดับน้ำ: ลดตามความลาดชันและประมาณค่าระหว่างสถานี', () => {
  const p = M.makeProfile([{ chainage: 10, ws: 12, leftBank: 11.7, rightBank: 11.8 }], 0.1);
  assert.ok(Math.abs(p.ws(20) - 11) < 1e-9);
  assert.ok(Math.abs(p.ws(0) - 13) < 1e-9);
  const p2 = M.makeProfile([
    { chainage: 0, ws: 12, leftBank: 11, rightBank: 11 },
    { chainage: 10, ws: NaN, leftBank: 9, rightBank: 9 },
    { chainage: 20, ws: 10, leftBank: 8, rightBank: 8 }
  ], 0.1);
  assert.ok(Math.abs(p2.ws(10) - 11) < 1e-9);
  assert.ok(Math.abs(p2.leftBank(5) - 10) < 1e-9);
});

// ตารางสังเคราะห์: แม่น้ำไหลจากตะวันตกไปตะวันออกกลางภาพ
// ฝั่งเหนือ (ซ้ายเมื่อมองตามน้ำ) เป็นที่ลุ่ม 10 ม. มีเนินกั้น 15 ม. และแอ่ง 9 ม. หลังเนิน
// ฝั่งใต้ (ขวา) สูง 11.9 ม.
function synthGrid() {
  const z = 14, w = 200, h = 120;
  const x0 = Math.floor(M.lonToX(99.8, z)), y0 = Math.floor(M.latToY(13.8, z));
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let e;
    if (y < 60) e = 10;           // ฝั่งซ้าย (เหนือ)
    else e = 11.9;                 // ฝั่งขวา (ใต้)
    if (y < 20 && x > 150) e = 9;  // แอ่งหลังเนิน
    if (y < 30 && x === 150) e = 15; // เนิน
    if (y === 30 && x >= 150) e = 15;
    elev[y * w + x] = e;
  }
  const grid = { z, x0, y0, w, h, elev };
  const line = [M.gridLatLon(grid, 0, 60), M.gridLatLon(grid, w - 1, 60)];
  return { grid, line };
}

test('น้ำล้นเฉพาะฝั่งที่ต่ำกว่าระดับน้ำ และไม่ข้ามเนิน', () => {
  const { grid, line } = synthGrid();
  const river = M.rasterizeRiver(grid, line, 30);
  const L = 11.73, Rb = 11.81;
  // 11.78: สูงกว่าตลิ่งซ้าย 11.73 แต่ต่ำกว่าตลิ่งขวา 11.81
  const profile = M.makeProfile([{ chainage: 0, ws: 11.78, leftBank: L, rightBank: Rb }], 0);
  const res = M.simulate(grid, river, profile, { demOffsetM: 0, maxSpreadKm: 50 });
  const at = (x, y) => res.depth[y * grid.w + x];
  assert.ok(Math.abs(at(50, 10) - 1.78) < 1e-4, 'ฝั่งซ้ายที่ลุ่มต้องท่วม ~1.78 ม.');
  assert.strictEqual(at(50, 100), 0, 'ฝั่งขวาสูง 11.9 ต้องไม่ท่วม');
  assert.strictEqual(at(180, 10), 0, 'แอ่งหลังเนินไม่เชื่อมต่อ ต้องไม่ท่วม');
  assert.ok(res.stats.areaRai > 0);
  assert.ok(res.overflowKm.left > 0);
  assert.strictEqual(res.overflowKm.right, 0);
});

test('ระดับน้ำต่ำกว่าตลิ่ง → ไม่มีน้ำท่วม', () => {
  const { grid, line } = synthGrid();
  const river = M.rasterizeRiver(grid, line, 30);
  const profile = M.makeProfile([{ chainage: 0, ws: 11.65, leftBank: 11.73, rightBank: 11.81 }], 0);
  const res = M.simulate(grid, river, profile, { demOffsetM: 0, maxSpreadKm: 50 });
  assert.strictEqual(res.stats.areaRai, 0);
});

test('ระยะแพร่กระจายสูงสุดถูกจำกัด', () => {
  const { grid, line } = synthGrid();
  const river = M.rasterizeRiver(grid, line, 30);
  const profile = M.makeProfile([{ chainage: 0, ws: 12.5, leftBank: 11.73, rightBank: 11.81 }], 0);
  const near = M.simulate(grid, river, profile, { demOffsetM: 0, maxSpreadKm: 0.1 });
  const far = M.simulate(grid, river, profile, { demOffsetM: 0, maxSpreadKm: 50 });
  assert.ok(near.stats.areaRai < far.stats.areaRai);
});

test('แปลงข้อมูล ThaiWater และตรวจจับน้ำล้นตลิ่ง', () => {
  const json = {
    waterlevel_data: {
      data: [
        {
          waterlevel_msl: '11.95', waterlevel_datetime: '2026-09-29 08:00',
          station: { id: 1, tele_station_name: { th: 'สะพานรถยนต์ค่ายหลวง' }, tele_station_oldcode: 'K.55A',
            tele_station_lat: 13.81, tele_station_long: 99.87, left_bank: 11.73, right_bank: 11.81, min_bank: 11.73 },
          geocode: { province_code: '70', province_name: { th: 'ราชบุรี' }, amphoe_name: { th: 'บ้านโป่ง' } }
        },
        {
          waterlevel_msl: 3.1,
          station: { id: 2, tele_station_name: { th: 'สถานีไกล' }, tele_station_lat: 18.8, tele_station_long: 98.9, min_bank: 5 },
          geocode: { province_code: '50', province_name: { th: 'เชียงใหม่' } }
        }
      ]
    }
  };
  const all = TW.parse(json);
  assert.strictEqual(all.length, 2);
  const region = TW.filterRegion(all, CFG.thaiwater, CFG.bbox);
  assert.strictEqual(region.length, 1);
  assert.ok(Math.abs(region[0].overflow - 0.22) < 1e-9);
  assert.ok(TW.isPrimary(region[0], 'K.55A'));
  assert.strictEqual(region[0].amphoe, 'บ้านโป่ง');
});
