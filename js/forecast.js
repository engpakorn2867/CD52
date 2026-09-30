// คาดการณ์ระดับน้ำ K.55A ตามเวลา
//
// ลำดับข้อมูล:
//  1. ค่าสังเกตล่าสุด (เช่น 30 ก.ย. 2569 09:00 น. = 10.21 ม.รทก.)
//  2. ตารางคาดการณ์ทางการ (ระดับ/เวลา) ต่อเชื่อมแบบเส้นตรงเป็นช่วง
//  3. หลังจุดสุดท้ายของตาราง ใช้แบบจำลองต่อยอด:
//       ขึ้นต่อ riseRate ม./ชม. นาน peakAfterH ชม. (รูปแบบ 'decay' = อัตราลดลงเป็นเส้นตรงจนเป็น 0 ที่ยอด,
//       'linear' = อัตราคงที่จนถึงยอด) → คงที่ holdH ชม. → ลดลง fallRate ม./ชม.
//  ก่อนค่าสังเกต ย้อนหลังด้วย riseRate เพื่อหาเวลาที่น้ำเริ่มล้นตลิ่ง
// ปริมาณน้ำคำนวณจาก rating curve (ระดับ → Q)
(function (root) {
  var HOUR = 3600000;
  var R = root.Rating || (typeof require !== 'undefined' ? require('./rating.js') : null);

  function parseTime(s) { return typeof s === 'number' ? s : Date.parse(s); }

  // cfg: { obs: {time, h}, table: [{time, h}], riseRate, riseShape, peakAfterH, holdH, fallRate,
  //        horizonH, bank, ratingCurve, floorBelowBank }
  function build(cfg) {
    var obs = { t: parseTime(cfg.obs.time), h: cfg.obs.h };
    var known = [{ t: obs.t, h: obs.h, kind: 'obs' }];
    (cfg.table || []).forEach(function (p) {
      var t = parseTime(p.time);
      if (t > obs.t) known.push({ t: t, h: p.h, kind: 'table' });
    });
    known.sort(function (a, b) { return a.t - b.t; });
    var last = known[known.length - 1];
    var r = cfg.riseRate, Tp = Math.max(0, cfg.peakAfterH || 0), hold = Math.max(0, cfg.holdH || 0);
    var fall = Math.max(0, cfg.fallRate || 0), bank = cfg.bank;
    var floor = bank - (cfg.floorBelowBank == null ? 3 : cfg.floorBelowBank);
    var linear = cfg.riseShape === 'linear';
    var peakRise = Tp ? (linear ? r * Tp : r * Tp / 2) : 0;
    var peak = { t: last.t + Tp * HOUR, h: last.h + peakRise };

    function hAt(t) {
      if (t <= obs.t) return obs.h - r * (obs.t - t) / HOUR;
      if (t <= last.t) {
        for (var i = 1; i < known.length; i++) {
          if (t <= known[i].t) {
            var a = known[i - 1], b = known[i];
            return a.h + (b.h - a.h) * (t - a.t) / (b.t - a.t);
          }
        }
      }
      var dt = (t - last.t) / HOUR;
      if (dt <= Tp) return last.h + (linear ? r * dt : r * (dt - dt * dt / (2 * Tp)));
      if (dt <= Tp + hold) return peak.h;
      return Math.max(floor, peak.h - fall * (dt - Tp - hold));
    }
    function qAt(t) { return R.dischargeFromLevel(cfg.ratingCurve, hAt(t)); }

    // เวลาที่น้ำเริ่มล้นตลิ่ง (ย้อนหลังจากค่าสังเกต หรือเดินหน้าหากยังไม่ล้น)
    var start = null;
    if (obs.h > bank) start = r > 0 ? obs.t - (obs.h - bank) / r * HOUR : obs.t;
    var end = obs.t + (cfg.horizonH || 72) * HOUR;
    // เวลาที่ลดลงต่ำกว่าตลิ่ง
    var recede = null, rose = null;
    for (var t = obs.t; t <= end; t += 5 * 60000) {
      var h = hAt(t);
      if (start == null && h > bank && rose == null) rose = t;
      if (t > peak.t && h <= bank && (start != null || rose != null)) { recede = t; break; }
    }
    if (start == null) start = rose;

    // จุดสำคัญ: ระดับถึงค่าต่างๆ ทุก 0.25 ม.
    var milestones = [];
    var hi = Math.max(peak.h, last.h), lo = obs.h;
    for (var lv = Math.ceil(lo * 4) / 4; lv <= hi + 1e-9; lv += 0.25) {
      var when = crossTime(hAt, obs.t, Math.min(end, Math.max(peak.t, last.t)), lv);
      if (when != null) milestones.push({ h: lv, t: when, q: R.dischargeFromLevel(cfg.ratingCurve, lv) });
    }

    return {
      obs: obs, known: known, last: last, peak: { t: peak.t, h: peak.h, q: R.dischargeFromLevel(cfg.ratingCurve, peak.h) },
      start: start, end: end, recede: recede, bank: bank,
      hAt: hAt, qAt: qAt, milestones: milestones,
      bankfullQ: R.dischargeFromLevel(cfg.ratingCurve, bank),
      series: function (stepMin, from, to) {
        var out = [], s = from == null ? Math.min(start || obs.t, obs.t) : from, e = to == null ? end : to;
        for (var tt = s; tt <= e + 1; tt += stepMin * 60000) out.push({ t: tt, h: hAt(tt), q: qAt(tt) });
        return out;
      }
    };
  }

  // หาเวลาที่ระดับน้ำขึ้นถึง level ครั้งแรกในช่วง [t0, t1]
  function crossTime(hAt, t0, t1, level) {
    var step = 60000;
    var prev = hAt(t0);
    if (prev >= level) return prev === level ? t0 : null;
    for (var t = t0 + step; t <= t1; t += step) {
      var h = hAt(t);
      if (h >= level) return t - step + step * (level - prev) / ((h - prev) || 1);
      prev = h;
    }
    return null;
  }

  var PRESETS = {
    mid: { label: 'ค่ากลาง', riseShape: 'decay', peakAfterH: 12, holdH: 0, fallRate: 0.05,
      desc: 'อัตราเพิ่มค่อยๆ ลดลงจนถึงยอดใน 12 ชม. หลังจุดคาดการณ์สุดท้าย แล้วลด 5 ซม./ชม.' },
    worst: { label: 'เลวร้าย', riseShape: 'linear', peakAfterH: 12, holdH: 6, fallRate: 0.03,
      desc: 'ขึ้นต่อเนื่องด้วยอัตราเดิมอีก 12 ชม. ทรงตัว 6 ชม. แล้วลดช้า 3 ซม./ชม.' },
    best: { label: 'ดีที่สุด', riseShape: 'decay', peakAfterH: 0, holdH: 6, fallRate: 0.08,
      desc: 'ถึงยอดที่จุดคาดการณ์สุดท้าย ทรงตัว 6 ชม. แล้วลด 8 ซม./ชม.' }
  };

  var api = { build: build, crossTime: crossTime, PRESETS: PRESETS, HOUR: HOUR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Forecast = api;
})(this);
