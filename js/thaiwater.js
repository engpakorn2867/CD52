// ดึงและแปลงข้อมูลระดับน้ำล่าสุดจากคลังข้อมูลน้ำแห่งชาติ (www.thaiwater.net / api-v3.thaiwater.net)
(function (root) {
  function pick(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (cur == null) return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }
  function text(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.th || v.en || v.jp || '';
    return String(v);
  }
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : NaN;
  }
  function first() {
    for (var i = 0; i < arguments.length; i++) if (isFinite(arguments[i])) return arguments[i];
    return NaN;
  }

  // หา array ของรายการที่มีฟิลด์ waterlevel_msl ในโครงสร้าง JSON ใดๆ
  function findRecords(node, out, depth) {
    out = out || []; depth = depth || 0;
    if (!node || depth > 6) return out;
    if (Array.isArray(node)) {
      if (node.length && node[0] && typeof node[0] === 'object' && ('waterlevel_msl' in node[0] || 'waterlevel_m' in node[0])) {
        return out.concat(node);
      }
      for (var i = 0; i < node.length; i++) out = findRecords(node[i], out, depth + 1);
      return out;
    }
    if (typeof node === 'object') {
      for (var k in node) if (Object.prototype.hasOwnProperty.call(node, k)) out = findRecords(node[k], out, depth + 1);
    }
    return out;
  }

  function normalize(r) {
    var st = r.station || r.tele_station || {};
    var geo = r.geocode || st.geocode || {};
    var left = num(first(num(st.left_bank), num(r.left_bank)));
    var right = num(first(num(st.right_bank), num(r.right_bank)));
    var minBank = first(num(st.min_bank), num(r.min_bank),
      isFinite(left) && isFinite(right) ? Math.min(left, right) : NaN, left, right);
    var wl = first(num(r.waterlevel_msl), num(r.waterlevel_m));
    return {
      id: st.id || r.id,
      code: text(st.tele_station_oldcode || st.station_oldcode || r.station_oldcode || ''),
      name: text(st.tele_station_name || st.station_name || r.station_name),
      lat: first(num(st.tele_station_lat), num(st.station_lat), num(r.lat)),
      lon: first(num(st.tele_station_long), num(st.station_long), num(r.long), num(r.lon)),
      provinceCode: String(geo.province_code || r.province_code || ''),
      province: text(geo.province_name || r.province_name),
      amphoe: text(geo.amphoe_name),
      tambon: text(geo.tumbon_name || geo.tambon_name),
      basin: text(pick(r, ['basin', 'basin_name']) || pick(st, ['basin', 'basin_name'])),
      wl: wl,
      leftBank: left,
      rightBank: right,
      minBank: minBank,
      ground: first(num(st.ground_level), num(r.ground_level)),
      discharge: first(num(r.discharge), num(r.flow_rate)),
      storagePct: num(r.storage_percent),
      time: r.waterlevel_datetime || r.datetime || r.date || '',
      agency: text(pick(r, ['agency', 'agency_shortname']) || pick(st, ['agency', 'agency_shortname']))
    };
  }

  function overflowOf(s) {
    return isFinite(s.wl) && isFinite(s.minBank) ? s.wl - s.minBank : NaN;
  }

  function parse(json) {
    var recs = findRecords(json).map(normalize).filter(function (s) { return isFinite(s.wl); });
    recs.forEach(function (s) { s.overflow = overflowOf(s); });
    return recs;
  }

  // กรองสถานีในราชบุรี หรือสถานีใกล้แม่น้ำแม่กลองภายในขอบเขตพื้นที่
  function filterRegion(stations, cfg, bbox) {
    return stations.filter(function (s) {
      var inProv = s.provinceCode === cfg.provinceCode || s.province.indexOf(cfg.provinceName) >= 0;
      var inBox = isFinite(s.lat) && s.lat >= bbox.south && s.lat <= bbox.north && s.lon >= bbox.west && s.lon <= bbox.east;
      return inProv || inBox;
    });
  }

  function isPrimary(s, code) {
    var c = (s.code || '').replace(/\s/g, '').toUpperCase();
    return c === code.toUpperCase() || /ค่ายหลวง/.test(s.name);
  }

  // ลองดึงจาก endpoint ตามลำดับ คืน { url, stations }
  function fetchLatest(endpoints) {
    var errors = [];
    var i = 0;
    function next() {
      if (i >= endpoints.length) {
        return Promise.reject(new Error('ดึงข้อมูล ThaiWater ไม่สำเร็จ: ' + errors.join(' | ')));
      }
      var url = endpoints[i++];
      return fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
          return r.json();
        })
        .then(function (json) {
          var st = parse(json);
          if (!st.length) throw new Error(url + ' → ไม่พบข้อมูลระดับน้ำ');
          return { url: url, stations: st };
        })
        .catch(function (e) { errors.push(e.message); return next(); });
    }
    return next();
  }

  var api = {
    parse: parse, normalize: normalize, filterRegion: filterRegion,
    isPrimary: isPrimary, fetchLatest: fetchLatest
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ThaiWater = api;
})(this);
