// Rating Curve: แปลงปริมาณน้ำ (Q) <-> ระดับน้ำ (H) ด้วยการประมาณค่าเชิงเส้นเป็นช่วง
(function (root) {
  function sorted(curve, idx) {
    return curve.slice().sort(function (a, b) { return a[idx] - b[idx]; });
  }

  // ประมาณค่าระหว่างจุด; นอกช่วงตารางใช้ความชันของช่วงปลาย (extrapolate)
  function interp(curve, x, from, to) {
    var c = sorted(curve, from);
    var n = c.length;
    if (n === 0) return NaN;
    if (n === 1) return c[0][to];
    var i = 0;
    if (x <= c[0][from]) i = 0;
    else if (x >= c[n - 1][from]) i = n - 2;
    else while (i < n - 2 && x > c[i + 1][from]) i++;
    var a = c[i], b = c[i + 1];
    var t = (x - a[from]) / (b[from] - a[from]);
    return a[to] + t * (b[to] - a[to]);
  }

  function levelFromDischarge(curve, q) { return interp(curve, q, 0, 1); }
  function dischargeFromLevel(curve, h) { return interp(curve, h, 1, 0); }

  // สถานะเทียบตลิ่ง
  function bankStatus(h, leftBank, rightBank) {
    var low = Math.min(leftBank, rightBank), high = Math.max(leftBank, rightBank);
    var lowSide = leftBank <= rightBank ? 'ซ้าย' : 'ขวา';
    if (h <= low) return { level: 0, label: 'ต่ำกว่าตลิ่ง', excess: h - low, freeboard: low - h };
    if (h <= high) return { level: 1, label: 'ล้นตลิ่ง' + lowSide, excess: h - low, freeboard: 0 };
    return { level: 2, label: 'ล้นตลิ่งทั้งสองฝั่ง', excess: h - low, freeboard: 0 };
  }

  var api = {
    levelFromDischarge: levelFromDischarge,
    dischargeFromLevel: dischargeFromLevel,
    bankStatus: bankStatus
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Rating = api;
})(this);
