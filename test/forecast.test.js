'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CFG = require('../js/config.js');
const F = require('../js/forecast.js');
const R = require('../js/rating.js');

const base = Object.assign({}, CFG.forecast, { bank: 9, ratingCurve: CFG.primaryStation.ratingCurve });
const H = 3600000;

test('rating curve: ตลิ่ง 9.00 ม. = 1,730 และตรงกับตารางคาดการณ์', () => {
  const c = CFG.primaryStation.ratingCurve;
  assert.strictEqual(R.dischargeFromLevel(c, 9), 1730);
  for (const p of CFG.forecast.table) assert.ok(Math.abs(R.dischargeFromLevel(c, p.h) - p.q) < 1e-6);
  assert.ok(Math.abs(R.dischargeFromLevel(c, 10.21) - 2264) < 2);
  assert.strictEqual(R.bankStatus(10.21, 9, 9).label, 'ล้นตลิ่ง');
});

test('คาดการณ์ผ่านค่าสังเกตและตาราง และหาเวลาเริ่มล้นตลิ่ง', () => {
  const f = F.build(Object.assign({}, base, F.PRESETS.mid));
  assert.strictEqual(f.hAt(Date.parse('2026-09-30T09:00:00+07:00')), 10.21);
  for (const p of CFG.forecast.table) assert.ok(Math.abs(f.hAt(Date.parse(p.time)) - p.h) < 1e-9);
  // ล้นตลิ่งตั้งแต่ 1.21/0.137 ≈ 8.83 ชม. ก่อน 09:00 → ~00:10 น.
  assert.ok(Math.abs((f.obs.t - f.start) / H - 1.21 / 0.137) < 1e-6);
  // ค่ากลาง: ยอด = 12.00 + 0.137×12/2 = 12.822 ที่ 22:26 + 12 ชม.
  assert.ok(Math.abs(f.peak.h - 12.822) < 1e-9);
  assert.strictEqual(f.peak.t, Date.parse('2026-10-01T10:26:00+07:00'));
  // หลังยอดลด 0.05 ม./ชม.
  assert.ok(Math.abs(f.hAt(f.peak.t + 10 * H) - (12.822 - 0.5)) < 1e-9);
  const m = f.milestones.find(x => x.h === 12.5);
  assert.ok(m && m.t > Date.parse('2026-09-30T22:26:00+07:00') && m.t < f.peak.t);
});

test('สถานการณ์ดีที่สุด: ลดกลับต่ำกว่าตลิ่งภายในช่วงคาดการณ์', () => {
  const f = F.build(Object.assign({}, base, F.PRESETS.best));
  assert.strictEqual(f.peak.h, 12);
  // 12.00 → 9.00 ที่ 0.08 ม./ชม. = 37.5 ชม. หลังทรงตัว 6 ชม.
  const expect = Date.parse('2026-09-30T22:26:00+07:00') + (6 + 37.5) * H;
  assert.ok(Math.abs(f.recede - expect) <= 5 * 60000);
});
