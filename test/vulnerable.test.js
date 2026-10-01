'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../js/vulnerable.js');

// ข้อมูลสมมติ (ไม่ใช่ข้อมูลจริง)
const rows = [
  ['ทะเบียนข้อมูลผู้ป่วยกลุ่มเปราะบาง'],
  ['หน่วยงาน: ทดสอบ'],
  [null, null, null, 'ที่อยู่'],
  ['ลำดับ', 'ชื่อ', 'กลุ่มเปราะบาง(ADL)/พิการ', 'บ้านเลขที่', 'หมู่ที่', 'ตำบล', 'อำเภอ', 'จังหวัด', 'รพ.สต.'],
  [1, 'นายทดสอบ  หนึ่ง', 'ติดบ้าน', '1', 2, 'คุ้งพยอม', 'บ้านโป่ง', 'ราชบุรี', 'คุ้งพยอม'],
  [2, 'นางทดสอบ  สอง', 'ติดเดตียง', '2', 2, 'คุ้งพยอม', 'บ้านโป่ง', 'ราชบุรี', 'คุ้งพยอม'],
  [3, 'นายทดสอบ  สาม', 3, '3', '1', 'บ้านม่วง', 'บ้านโป่ง', 'ราชบุรี', 'สวนกล้วย'],
  [4, 'นางทดสอบ  สี่', 'ได้ยิน', '4', '1', 'บ้านม่วง', 'บ้านโป่ง', 'ราชบุรี', 'สวนกล้วย'],
  [5, 'นายทดสอบ  ห้า', null, '5', '3', 'ท่าผา', 'บ้านโป่ง', 'ราชบุรี', 'ท่าผา'],
  [null, null, null, null, null, null, null, null, null]
];

test('จำแนกกลุ่มเปราะบาง: ข้อความสะกดผิดและคะแนน ADL', () => {
  assert.strictEqual(V.classify('ติดเดตียง').level, 1);
  assert.strictEqual(V.classify('ติดเตีบง').level, 1);
  assert.strictEqual(V.classify('กลุ่มติดบ้าน').level, 2);
  assert.strictEqual(V.classify(4).level, 1);
  assert.strictEqual(V.classify(5).level, 2);
  assert.strictEqual(V.classify(11).level, 2);
  assert.strictEqual(V.classify(12).level, 4);
  assert.strictEqual(V.classify('เคลื่อนไหว').level, 2);
  assert.strictEqual(V.classify('ปัญญา').level, 3);
  assert.strictEqual(V.classify(null).level, 4);
});

test('อ่านทะเบียนและเรียงลำดับการช่วยเหลือ', () => {
  const p = V.parseRows(rows);
  assert.strictEqual(p.records.length, 5);
  const list = V.prioritize(p.records, { tambons: ['คุ้งพยอม', 'บ้านม่วง'] });
  assert.strictEqual(list.length, 4);
  assert.deepStrictEqual(list.map(r => r.level), [1, 1, 2, 3]);
  // หมู่บ้านที่น้ำท่วมมาก่อน แม้ระดับความเร่งด่วนต่ำกว่า
  const pins = { 'บ้านม่วง|1': [99.85, 13.8], 'คุ้งพยอม|2': [99.86, 13.85] };
  const floodAt = (lon) => lon < 99.855 ? { depth: 0.8, risk: false } : { depth: 0, risk: false };
  const l2 = V.prioritize(p.records, { tambons: ['คุ้งพยอม', 'บ้านม่วง'], pins, floodAt });
  assert.deepStrictEqual(l2.map(r => r.tambon), ['บ้านม่วง', 'บ้านม่วง', 'คุ้งพยอม', 'คุ้งพยอม']);
  assert.strictEqual(l2[0].level, 1);
  const g = V.byMoo(l2);
  assert.strictEqual(g[0].key, 'บ้านม่วง|1');
  assert.strictEqual(g[0].total, 2);
  assert.strictEqual(V.maskName('นายทดสอบ หนึ่ง'), 'นายทดสอบ ห.');
});

test('หมู่ริมน้ำมาก่อนเมื่อสถานะน้ำท่วมเท่ากัน', () => {
  const p = V.parseRows(rows);
  const river = k => ({ 'บ้านม่วง|1': { cls: 'river' }, 'คุ้งพยอม|2': { cls: 'far', confirmed: true } })[k] || null;
  const l = V.prioritize(p.records, { tambons: ['คุ้งพยอม', 'บ้านม่วง'], river });
  // บ้านม่วง ม.1 ริมน้ำ (ระดับ 2, 3) มาก่อน คุ้งพยอม ม.2 ห่างน้ำ แม้จะมีผู้ติดเตียง
  assert.deepStrictEqual(l.map(r => r.tambon), ['บ้านม่วง', 'บ้านม่วง', 'คุ้งพยอม', 'คุ้งพยอม']);
  assert.strictEqual(l[0].river.key, 'river');
  assert.strictEqual(l[0].riverOk, false);
  assert.strictEqual(l[3].riverOk, true);
  assert.strictEqual(V.byMoo(l)[0].key, 'บ้านม่วง|1');
});
