'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../js/tambon-map.js');

test('จำแนกตำบล อ.บ้านโป่ง ตามแม่น้ำแม่กลอง', () => {
  const w = {};
  new Function('window', ['data/banpong-tambons.js', 'data/maeklong-river.js']
    .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n'))(w);
  const bp = T.classify(w.BANPONG_TAMBONS.features, w.MAEKLONG_RIVER);
  const by = c => bp.filter(f => f.properties.cls === c).map(f => f.properties.th).sort();
  assert.strictEqual(bp.length, 15);
  assert.deepStrictEqual(by('red'), ['คุ้งพยอม', 'ท่าผา', 'นครชุมน์', 'บ้านโป่ง', 'บ้านม่วง', 'ปากแรต', 'ลาดบัวขาว', 'สวนกล้วย', 'เบิกไพร'].sort());
  assert.deepStrictEqual(by('yellow'), ['กรับใหญ่', 'ดอนกระเบื้อง', 'หนองกบ', 'หนองปลาหมอ', 'หนองอ้อ'].sort());
  assert.deepStrictEqual(by('gray'), ['เขาขลุง']);
  // ตำบลสีเหลืองทุกตำบลต้องติดกับตำบลสีแดงอย่างน้อยหนึ่งตำบล
  const red = new Set(by('red'));
  for (const f of bp.filter(f => f.properties.cls === 'yellow')) assert.ok(f.properties.neighbors.some(n => red.has(n)), f.properties.th);
});
