'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const FF = require('../js/flood-forecast.js');

const w = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'data/banpong-flood.js'), 'utf8'))(w);
const meta = w.BANPONG_FLOOD;
const dec = s => PNG.sync.read(Buffer.from(s.split(',')[1], 'base64')).data;
const g = new FF.Grid(meta, dec(meta.a), dec(meta.b));

test('ตารางคาดการณ์น้ำท่วม: ตลิ่ง 9.00 ม. และโค้งความสัมพันธ์', () => {
  assert.strictEqual(meta.bank, 9);
  assert.strictEqual(meta.tambons.length, 15);
  assert.ok(Math.abs(g.dischargeFromLevel(9) - 1730) < 1);
  assert.ok(Math.abs(g.dischargeFromLevel(10.67) - 2467) < 10);
  assert.ok(Math.abs(g.levelFromDischarge(g.dischargeFromLevel(11.3)) - 11.3) < 1e-6);
});

test('ต่ำกว่าตลิ่งไม่ท่วม ระดับสูงขึ้นพื้นที่ไม่ลดลง', () => {
  assert.strictEqual(g.compute(8.8).total.rai, 0);
  let prev = 0;
  for (const H of [9.5, 10.2, 10.67, 11, 11.5, 12]) {
    const r = g.compute(H);
    assert.ok(r.total.rai >= prev - 1e-6, 'H ' + H);
    prev = r.total.rai;
    const sum = r.tambons.reduce((a, t) => a + t.rai, 0);
    assert.ok(Math.abs(sum - r.total.rai) < 1e-6);
  }
  assert.ok(prev > 10000, 'ระดับ 12 ม. ต้องท่วมเป็นวงกว้าง');
});

test('จำกัดตามปริมาตร: ใช้น้ำไม่เกินปริมาตรที่ล้น และพื้นที่ไม่เกินขอบเขตสูงสุด', () => {
  const H = 10.67, Q = g.dischargeFromLevel(H), V = (Q - 1730) * 24 * 3600;
  const full = g.compute(H), lim = g.compute(H, { volumeM3: V });
  assert.ok(lim.limited);
  assert.ok(Math.abs(lim.volumeUsed - V) / V < 0.02, lim.volumeUsed + ' vs ' + V);
  assert.ok(lim.total.rai <= full.total.rai);
  assert.ok(lim.total.damage > 0 && lim.total.damage <= full.total.damage);
  // ปริมาตรมากพอ = ขอบเขตสูงสุด
  assert.strictEqual(g.compute(H, { volumeM3: 1e12 }).total.rai, full.total.rai);
});

test('ระดับเริ่มท่วมรายตำบลอยู่เหนือตลิ่ง', () => {
  const on = g.onset.filter(v => v != null);
  assert.ok(on.length >= 12);
  for (const v of on) assert.ok(v >= 9 && v < 14);
});
