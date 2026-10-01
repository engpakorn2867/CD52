// บัญชีกลุ่มเปราะบาง: อ่านทะเบียน (แถวจาก Excel/CSV) จัดระดับความเร่งด่วนในการเข้าช่วยเหลือ และเรียงลำดับร่วมกับผลคาดการณ์น้ำท่วม
// ข้อมูลรายบุคคลเป็นข้อมูลอ่อนไหว (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562) — ไฟล์นี้ประมวลผลในเครื่องผู้ใช้เท่านั้น ไม่ส่งข้อมูลออก
(function (root) {
  // ระดับความเร่งด่วน (ความต้องการความช่วยเหลือในการอพยพ)
  var LEVELS = [
    null,
    { n: 1, label: 'ระดับ 1 ติดเตียง', short: 'ติดเตียง', color: '#c62828', need: 'เคลื่อนย้ายเองไม่ได้ ต้องใช้เปล/เรือ กำลังพล 2–4 นาย' },
    { n: 2, label: 'ระดับ 2 ติดบ้าน/พิการการเคลื่อนไหว-การมองเห็น', short: 'ติดบ้าน/เคลื่อนไหว', color: '#ef6c00', need: 'ต้องมีผู้ช่วยพยุง/รถเข็น/นำทาง' },
    { n: 3, label: 'ระดับ 3 พิการทางจิต สติปัญญา การได้ยิน การพูด', short: 'สื่อสาร/จิต', color: '#f9a825', need: 'ต้องมีผู้ดูแลและการแจ้งเตือนเฉพาะ' },
    { n: 4, label: 'ระดับ 4 ไม่ระบุกลุ่ม', short: 'ไม่ระบุ', color: '#757575', need: 'ตรวจสอบข้อมูลเพิ่มเติม' }
  ];

  // จำแนกค่าช่อง “กลุ่มเปราะบาง (ADL)/พิการ” — รับทั้งข้อความ (สะกดผิดได้) และคะแนน ADL (Barthel 0–20)
  function classify(v) {
    if (v == null || String(v).trim() === '') return { group: 'ไม่ระบุ', level: 4 };
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
      var adl = parseFloat(s);
      if (adl <= 4) return { group: 'ติดเตียง (ADL ' + s + ')', level: 1, adl: adl };
      if (adl <= 11) return { group: 'ติดบ้าน (ADL ' + s + ')', level: 2, adl: adl };
      return { group: 'ติดสังคม (ADL ' + s + ')', level: 4, adl: adl };
    }
    if (/ตียง|เตีบ|ตดเตี/.test(s)) return { group: s.indexOf('สูงอายุ') >= 0 ? 'ผู้สูงอายุติดเตียง' : 'ติดเตียง', level: 1 };
    if (/ติดบ้าน/.test(s)) return { group: s.indexOf('สูงอายุ') >= 0 ? 'ผู้สูงอายุติดบ้าน' : 'ติดบ้าน', level: 2 };
    if (/เคลื่อนไหว|ร่างกาย/.test(s)) return { group: 'พิการทางการเคลื่อนไหว', level: 2 };
    if (/มองเห็น|ตาบอด/.test(s)) return { group: 'พิการทางการมองเห็น', level: 2 };
    if (/จิต|พฤติกรรม|ออทิสติก/.test(s)) return { group: 'พิการทางจิต/พฤติกรรม', level: 3 };
    if (/ปัญญา|เรียนรู้/.test(s)) return { group: 'พิการทางสติปัญญา', level: 3 };
    if (/ได้ยิน|หูหนวก|สื่อความหมาย/.test(s)) return { group: 'พิการทางการได้ยิน', level: 3 };
    if (/พูด/.test(s)) return { group: 'พิการทางการพูด', level: 3 };
    if (/ติดสังคม/.test(s)) return { group: 'ติดสังคม', level: 4 };
    return { group: s, level: 4 };
  }

  // หาแถวหัวตารางและคอลัมน์ (ชื่อคอลัมน์ยืดหยุ่น)
  var COLS = {
    seq: /^ลำดับ/, name: /^ชื่อ/, group: /เปราะบาง|ADL|พิการ|กลุ่ม/, house: /บ้านเลขที่|เลขที่/, moo: /^หมู่/,
    tambon: /^ตำบล/, amphoe: /^อำเภอ/, province: /^จังหวัด/, hc: /รพ\.?\s*สต|สถานบริการ/, phone: /โทร/
  };
  function findHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 30); i++) {
      var r = rows[i] || [], map = {};
      r.forEach(function (c, j) {
        var s = String(c == null ? '' : c).trim();
        Object.keys(COLS).forEach(function (k) { if (map[k] == null && COLS[k].test(s)) map[k] = j; });
      });
      if (map.name != null && map.tambon != null) return { row: i, map: map };
    }
    return null;
  }

  // rows: อาร์เรย์ของแถว (แต่ละแถวเป็นอาร์เรย์ค่าเซลล์) → { records, header, skipped }
  function parseRows(rows) {
    var h = findHeader(rows);
    if (!h) throw new Error('ไม่พบหัวตารางที่มีคอลัมน์ “ชื่อ” และ “ตำบล”');
    var m = h.map, out = [], skipped = 0;
    function cell(r, k) { var v = m[k] == null ? null : r[m[k]]; return v == null ? '' : String(v).trim(); }
    for (var i = h.row + 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var name = cell(r, 'name').replace(/\s+/g, ' ');
      if (!name) continue;
      var tambon = cell(r, 'tambon').replace(/^ต\.\s*|^ตำบล\s*/, '');
      if (!tambon) { skipped++; continue; }
      var c = classify(m.group == null ? null : r[m.group]);
      out.push({
        seq: cell(r, 'seq'), name: name, groupRaw: m.group == null ? '' : cell(r, 'group'), group: c.group, level: c.level,
        house: cell(r, 'house'), moo: cell(r, 'moo').replace(/^ม\.?\s*|^หมู่(ที่)?\s*/, ''), tambon: tambon,
        amphoe: cell(r, 'amphoe'), hc: cell(r, 'hc').replace(/^รพ\.?สต\.?\s*/, ''), phone: cell(r, 'phone')
      });
    }
    return { records: out, header: h, skipped: skipped };
  }

  function mooKey(tambon, moo) { return tambon + '|' + (moo || '?'); }

  // สถานะน้ำท่วมของหมู่บ้าน: floodAt(lon, lat) → { depth, risk } หรือ null
  var FLOOD = [
    { key: 'flooded', label: 'น้ำท่วม', rank: 0 },
    { key: 'risk', label: 'เสี่ยงท่วม', rank: 1 },
    { key: 'unknown', label: 'ยังไม่ปักตำแหน่งหมู่บ้าน', rank: 2 },
    { key: 'dry', label: 'ไม่ท่วม', rank: 3 }
  ];
  function floodStatus(pin, floodAt) {
    if (!pin) return { key: 'unknown', rank: 2, depth: 0 };
    var f = floodAt ? floodAt(pin[0], pin[1]) : null;
    if (!f) return { key: 'unknown', rank: 2, depth: 0 };
    if (f.depth > 0.02) return { key: 'flooded', rank: 0, depth: f.depth };
    if (f.risk) return { key: 'risk', rank: 1, depth: 0 };
    return { key: 'dry', rank: 3, depth: 0 };
  }

  // ตำแหน่งหมู่บ้านเทียบแม่น้ำ — ใช้ช่วยหมู่ริมน้ำก่อนเมื่อสถานะน้ำท่วมเท่ากัน (ยังไม่ทราบ อยู่ก่อนห่างน้ำ เพื่อความปลอดภัย)
  var RIVER = {
    river: { key: 'river', label: 'ริมน้ำ', rank: 0, color: '#0277bd' },
    near: { key: 'near', label: 'ใกล้น้ำ 1–2 กม.', rank: 1, color: '#4fc3f7' },
    unknown: { key: 'unknown', label: 'ไม่ทราบ', rank: 2, color: '#9e9e9e' },
    far: { key: 'far', label: 'ห่างน้ำ', rank: 3, color: '#8d6e63' }
  };
  function riverOf(fn, key) { var v = fn ? fn(key) : null; return RIVER[v && v.cls] || RIVER.unknown; }

  function num(s) { var n = parseInt(String(s).replace(/[^\d].*$/, ''), 10); return isNaN(n) ? 9999 : n; }

  // เรียงลำดับการเข้าช่วยเหลือ: สถานะน้ำท่วมของหมู่บ้าน → ระดับความเร่งด่วน → ความลึกน้ำ → ตำบล → หมู่ → บ้านเลขที่
  // opts: { tambons: [ชื่อตำบล] | null, pins: { 'ตำบล|หมู่': [lon,lat] }, floodAt, levels: [1..4] }
  function prioritize(records, opts) {
    opts = opts || {};
    var pins = opts.pins || {}, list = [];
    records.forEach(function (r) {
      if (opts.tambons && opts.tambons.indexOf(r.tambon) < 0) return;
      if (opts.levels && opts.levels.indexOf(r.level) < 0) return;
      var pin = pins[mooKey(r.tambon, r.moo)] || null;
      var rv = opts.river ? opts.river(mooKey(r.tambon, r.moo)) : null;
      list.push(Object.assign({}, r, { pin: pin, flood: floodStatus(pin, opts.floodAt), river: riverOf(opts.river, mooKey(r.tambon, r.moo)), riverOk: !!(rv && rv.confirmed) }));
    });
    // ลำดับ: สถานะน้ำท่วมของหมู่บ้าน → หมู่ริมน้ำ/ใกล้น้ำ → ระดับความเร่งด่วน → ความลึกน้ำ
    list.sort(function (a, b) {
      return a.flood.rank - b.flood.rank || a.river.rank - b.river.rank || a.level - b.level || b.flood.depth - a.flood.depth ||
        a.tambon.localeCompare(b.tambon, 'th') || num(a.moo) - num(b.moo) || num(a.house) - num(b.house) || a.name.localeCompare(b.name, 'th');
    });
    list.forEach(function (r, i) { r.rank = i + 1; });
    return list;
  }

  // สรุปรายหมู่บ้าน (สำหรับหมุดบนแผนที่และตารางสรุป)
  function byMoo(list) {
    var map = {}, out = [];
    list.forEach(function (r) {
      var k = mooKey(r.tambon, r.moo), g = map[k];
      if (!g) { g = map[k] = { key: k, tambon: r.tambon, moo: r.moo, hc: r.hc, pin: r.pin, flood: r.flood, river: r.river || RIVER.unknown, riverOk: r.riverOk, total: 0, levels: [0, 0, 0, 0, 0], top: 4 }; out.push(g); }
      g.total++; g.levels[r.level]++; if (r.level < g.top) g.top = r.level;
    });
    out.sort(function (a, b) { return a.flood.rank - b.flood.rank || a.river.rank - b.river.rank || a.top - b.top || a.tambon.localeCompare(b.tambon, 'th') || num(a.moo) - num(b.moo); });
    return out;
  }

  // ปิดบังนามสกุล (ใช้เมื่อภาพจะถูกส่งต่อวงกว้าง)
  function maskName(name) {
    var p = String(name).split(/\s+/);
    if (p.length < 2) return name;
    return p[0] + ' ' + p[p.length - 1].charAt(0) + '.';
  }


  // ---------- ภาพตาราง (สำหรับบันทึกเป็นรูป/พิมพ์แจกชุดปฏิบัติการ) ----------
  var FONT = '"Sarabun","Noto Sans Thai","Leelawadee UI",Tahoma,sans-serif';
  var PER_PAGE = 28;
  function pageCount(list) { return 1 + Math.max(1, Math.ceil(list.length / PER_PAGE)); }
  function fit(ctx, text, maxW) {
    text = String(text == null ? '' : text);
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }
  function chip(ctx, x, y, w, h, color, text) {
    ctx.fillStyle = color; ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 5); else ctx.rect(x, y, w, h);
    ctx.fill(); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(text, x + w / 2, y + h / 2 + 1); ctx.textAlign = 'left';
  }
  function floodText(f) {
    if (f.key === 'flooded') return 'ท่วม ~' + f.depth.toFixed(1) + ' ม.';
    if (f.key === 'risk') return 'เสี่ยงท่วม';
    if (f.key === 'dry') return 'ไม่ท่วม';
    return 'ไม่ทราบตำแหน่ง';
  }
  var FLOOD_COLOR = { flooded: '#1565c0', risk: '#ef6c00', dry: '#2e7d32', unknown: '#9e9e9e' };

  // cfg: { canvas, list (จาก prioritize), page (0 = หน้าสรุปรายหมู่บ้าน, 1.. = รายชื่อ), title, subtitle, source, mask, teamFor(tambon) }
  function renderPage(cfg) {
    var cv = cfg.canvas, ctx = cv.getContext('2d'), W = cv.width, H = cv.height, P = 40, list = cfg.list, pages = pageCount(list);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = '#1a1a1a'; ctx.font = '700 34px ' + FONT;
    ctx.fillText(cfg.title || 'บัญชีกลุ่มเปราะบางที่ต้องเข้าช่วยเหลือเป็นลำดับแรก', P, 44);
    ctx.font = '500 18px ' + FONT; ctx.fillStyle = '#444';
    ctx.fillText(fit(ctx, cfg.subtitle || '', W - 2 * P - 160), P, 80);
    ctx.textAlign = 'right'; ctx.fillText('หน้า ' + (cfg.page + 1) + '/' + pages, W - P, 44); ctx.textAlign = 'left';
    // สรุปตัวเลข
    var y = 108, bw = (W - 2 * P - 5 * 12) / 6;
    var cnt = [0, 0, 0, 0, 0], fl = { flooded: 0, risk: 0, unknown: 0, dry: 0 };
    list.forEach(function (r) { cnt[r.level]++; fl[r.flood.key]++; });
    [['รวม', list.length + ' คน', '#263238'], [LEVELS[1].short, cnt[1] + ' คน', LEVELS[1].color], [LEVELS[2].short, cnt[2] + ' คน', LEVELS[2].color],
     [LEVELS[3].short + (cnt[4] ? ' / ไม่ระบุ ' + cnt[4] : ''), cnt[3] + ' คน', LEVELS[3].color],
     ['อยู่ในหมู่บ้านที่น้ำท่วม', fl.flooded + ' คน', FLOOD_COLOR.flooded], ['เสี่ยง / ไม่ทราบตำแหน่ง', fl.risk + ' / ' + fl.unknown + ' คน', FLOOD_COLOR.risk]].forEach(function (b, i) {
      var x = P + i * (bw + 12);
      ctx.fillStyle = '#f5f5f5'; ctx.fillRect(x, y, bw, 64); ctx.fillStyle = b[2]; ctx.fillRect(x, y, 6, 64);
      ctx.fillStyle = '#555'; ctx.font = '500 15px ' + FONT; ctx.fillText(fit(ctx, b[0], bw - 24), x + 16, y + 18);
      ctx.fillStyle = b[2]; ctx.font = '700 25px ' + FONT; ctx.fillText(b[1], x + 16, y + 45);
    });
    y += 84;
    var cols, rows;
    if (cfg.page === 0) {
      ctx.fillStyle = '#1a1a1a'; ctx.font = '700 20px ' + FONT; ctx.fillText('สรุปรายหมู่บ้าน — เรียงตามสถานะน้ำท่วม หมู่ริมน้ำ และความเร่งด่วน', P, y); y += 26;
      cols = [['ลำดับ', 70], ['ตำบล', 160], ['หมู่', 60], ['ที่ตั้งเทียบแม่น้ำ', 215], ['รพ.สต.', 125], ['ติดเตียง', 100], ['ติดบ้าน/เคลื่อนไหว', 170], ['สื่อสาร/จิต', 120], ['ไม่ระบุ', 80], ['รวม', 80], ['สถานะน้ำ (หมู่บ้าน)', 180], ['ชุดปฏิบัติการ', 0]];
      rows = byMoo(list).map(function (g, i) {
        return [i + 1, 'ต.' + g.tambon, g.moo, { riverCell: g }, g.hc, g.levels[1] || '-', g.levels[2] || '-', g.levels[3] || '-', g.levels[4] || '-', g.total, g, cfg.teamFor ? cfg.teamFor(g.tambon) : ''];
      });
    } else {
      cols = [['ลำดับช่วย', 90], ['ระดับ', 150], ['ชื่อ-สกุล', 250], ['กลุ่ม', 200], ['บ้านเลขที่', 105], ['หมู่', 55], ['ตำบล', 120], ['ริมน้ำ', 150], ['รพ.สต.', 110], ['สถานะน้ำ (หมู่บ้าน)', 170], ['ชุดปฏิบัติการ', 140], ['ช่วยแล้ว', 0]];
      rows = list.slice((cfg.page - 1) * PER_PAGE, cfg.page * PER_PAGE).map(function (r) {
        return [r.rank, r, cfg.mask ? maskName(r.name) : r.name, r.group, r.house, r.moo, r.tambon, { riverCell: r }, r.hc, r, cfg.teamFor ? cfg.teamFor(r.tambon) : '', '☐'];
      });
    }
    var x0 = P, tw = W - 2 * P, used = cols.reduce(function (a, c) { return a + c[1]; }, 0);
    cols[cols.length - 1][1] = Math.max(60, tw - used);
    var rh = cfg.page === 0 ? 31 : 30;
    ctx.fillStyle = '#37474f'; ctx.fillRect(x0, y, tw, 34);
    ctx.fillStyle = '#fff'; ctx.font = '700 15px ' + FONT;
    var cx = x0; cols.forEach(function (c) { ctx.fillText(fit(ctx, c[0], c[1] - 12), cx + 8, y + 17); cx += c[1]; });
    y += 34;
    var maxRows = Math.floor((H - y - 70) / rh);
    rows.slice(0, maxRows).forEach(function (r, i) {
      ctx.fillStyle = i % 2 ? '#fafafa' : '#fff'; ctx.fillRect(x0, y, tw, rh);
      ctx.strokeStyle = '#e0e0e0'; ctx.beginPath(); ctx.moveTo(x0, y + rh); ctx.lineTo(x0 + tw, y + rh); ctx.stroke();
      cx = x0;
      r.forEach(function (v, j) {
        var w = cols[j][1];
        ctx.font = (j === 2 && cfg.page > 0 ? '600 ' : '400 ') + '16px ' + FONT; ctx.fillStyle = '#1a1a1a';
        if (v && typeof v === 'object' && v.riverCell) {
          var rc = v.riverCell.river || RIVER.unknown;
          ctx.font = '700 14px ' + FONT; ctx.fillStyle = rc.key === 'river' ? rc.color : rc.key === 'near' ? '#0288d1' : '#757575';
          ctx.fillText(fit(ctx, (rc.key === 'river' ? '≈ ' : '') + rc.label + (rc.key !== 'unknown' && !v.riverCell.riverOk ? ' (ประมาณ)' : ''), w - 12), cx + 8, y + rh / 2);
        }
        else if (v && typeof v === 'object' && v.level != null && cfg.page > 0 && j === 1) { ctx.font = '700 13px ' + FONT; chip(ctx, cx + 6, y + 5, w - 14, rh - 10, LEVELS[v.level].color, LEVELS[v.level].short); }
        else if (v && typeof v === 'object' && v.flood) { ctx.font = '700 14px ' + FONT; ctx.fillStyle = FLOOD_COLOR[v.flood.key]; ctx.fillText(fit(ctx, floodText(v.flood), w - 12), cx + 8, y + rh / 2); }
        else if (j === 5 && cfg.page === 0 && v !== '-') { ctx.font = '700 16px ' + FONT; ctx.fillStyle = LEVELS[1].color; ctx.fillText(v, cx + 8, y + rh / 2); }
        else { if (j === r.length - 1 && cfg.page > 0) ctx.font = '400 20px ' + FONT; ctx.fillText(fit(ctx, v, w - 12), cx + 8, y + rh / 2); }
        cx += w;
      });
      y += rh;
    });
    if (rows.length > maxRows) { ctx.fillStyle = '#b71c1c'; ctx.font = '600 14px ' + FONT; ctx.fillText('…และอีก ' + (rows.length - maxRows) + ' รายการ', x0, y + 14); }
    // ท้ายภาพ
    ctx.font = '400 13px ' + FONT; ctx.fillStyle = '#555';
    var lv = LEVELS.slice(1).map(function (l) { return l.label + ': ' + l.need; }).join(' · ');
    ctx.fillText(fit(ctx, 'เกณฑ์: ' + lv, W - 2 * P), P, H - 50);
    ctx.fillText(fit(ctx, 'ลำดับช่วย: หมู่บ้านที่น้ำท่วม (ตามแบบจำลองคาดการณ์) → หมู่ริมน้ำ/ใกล้น้ำ → ระดับความเร่งด่วน → ความลึกน้ำ · “(ประมาณ)” = ตำแหน่งเทียบแม่น้ำยังไม่ยืนยันกับพื้นที่ · สถานะน้ำเป็นของตำแหน่งหมู่บ้านที่ปักไว้ ไม่ใช่รายบ้าน' + (cfg.source ? ' · ที่มา: ' + cfg.source : ''), W - 2 * P), P, H - 30);
    ctx.fillStyle = '#b71c1c'; ctx.font = '700 13px ' + FONT;
    ctx.fillText('ข้อมูลส่วนบุคคล — ใช้เพื่อการช่วยเหลือผู้ประสบภัยเท่านั้น ห้ามเผยแพร่ต่อสาธารณะ (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562)', P, H - 10);
  }

  var api = { RIVER: RIVER, renderPage: renderPage, pageCount: pageCount, PER_PAGE: PER_PAGE, floodText: floodText, LEVELS: LEVELS, FLOOD: FLOOD, classify: classify, parseRows: parseRows, prioritize: prioritize, byMoo: byMoo, mooKey: mooKey, maskName: maskName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Vulnerable = api;
})(this);
