#!/usr/bin/env python3
# ปรับแนวเขตตำบล อ.บ้านโป่ง และหาตำแหน่งหมู่บ้าน (หมู่ที่) จากที่อยู่ของสถานที่ใน Overture Maps
#
# 1) สถานที่ที่ที่อยู่/ชื่อระบุตำบลชัดเจน (ต./ตำบล/อบต./เทศบาลตำบล + ชื่อตำบล) ใช้เป็น “คะแนนเสียง” ของตำบลนั้น
#    ตัดจุดที่หลายสถานที่ใช้พิกัดเดียวกัน (มักเป็นพิกัดกลางตำบลที่ระบบแผนที่เดาให้)
# 2) แนวเขต: แบ่งพื้นที่อำเภอเป็นกริด ~110 ม. เซลล์ใดมีหลักฐานของตำบลอื่นหนักแน่นกว่าแนวเขตเดิม (≥ 2 จุดใกล้ๆ)
#    และตำบลนั้นอยู่ไม่เกิน 1.5 กม. จะย้ายเข้าตำบลนั้น แล้วเกลี่ยขอบ (majority filter) ขอบนอกอำเภอคงเดิม
# 3) หมู่บ้าน: จุดที่ระบุ “หมู่ X” + ตำบล ภายในตำบลนั้น → ตำแหน่งกลาง (medoid) ต่อหมู่ และระยะถึงแม่น้ำแม่กลอง
# ใช้งาน: pip install pyarrow shapely && python3 tools/build_villages.py
# เขียน: data/banpong-tambons.js (เฉพาะรูปร่างตำบลใน อ.บ้านโป่ง), data/banpong-villages.js
import os, sys, re, json, math, pickle, collections, time
from shapely import wkb
from shapely.geometry import shape, mapping, Point, box, LineString
from shapely.ops import unary_union

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
REL = 'overturemaps-us-west-2/release/2026-09-23.1'
B = (99.60, 13.74, 99.98, 13.97)
CACHE = os.path.join(ROOT, '.cache', 'overture_places_banpong.pkl')
KX, KY = 111.32 * math.cos(math.radians(13.85)), 110.57   # กม./องศา


def fetch():
    if os.path.exists(CACHE):
        return pickle.load(open(CACHE, 'rb'))
    import pyarrow.dataset as ds, pyarrow.fs as pfs, pyarrow.compute as pc
    proxy = os.environ.get('HTTPS_PROXY')
    fs = pfs.S3FileSystem(anonymous=True, region='us-west-2', **({'proxy_options': proxy} if proxy else {}))
    d = ds.dataset(f'{REL}/theme=places/type=place/', filesystem=fs, format='parquet')
    f = (pc.field('bbox', 'xmin') < B[2]) & (pc.field('bbox', 'xmax') > B[0]) & (pc.field('bbox', 'ymin') < B[3]) & (pc.field('bbox', 'ymax') > B[1])
    rows = d.to_table(columns=['names', 'addresses', 'basic_category', 'confidence', 'geometry'], filter=f).to_pylist()
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    pickle.dump(rows, open(CACHE, 'wb'))
    return rows


def km(a, b):
    return math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY)


def main():
    t0 = time.time()
    places = fetch()
    src = open(os.path.join(ROOT, 'data/banpong-tambons.js'), encoding='utf8').read()
    m = re.search(r'window\.BANPONG_TAMBONS = (\{.*\});', src, re.S)
    fc = json.loads(m.group(1))
    bp = [f for f in fc['features'] if f['properties']['role'] == 'banpong']
    names = [f['properties']['th'] for f in bp]
    orig = {f['properties']['th']: shape(f['geometry']).buffer(0) for f in bp}
    district = unary_union(list(orig.values())).buffer(0)
    rv = open(os.path.join(ROOT, 'data/maeklong-river.js'), encoding='utf8').read()
    river = LineString([(p[1], p[0]) for p in json.loads(re.search(r'=\s*(\[.*\])', rv, re.S).group(1))])

    # ---- 1) จุดที่ระบุตำบล ----
    var = {n: [n] for n in names}
    var['นครชุมน์'] += ['นครชุม', 'นคร์ชุมน์', 'นครชุมม์', 'นครชุมป์']
    pats = {n: re.compile(r'(?:ต\.|ตำบล|อบต\.?|องค์การบริหารส่วนตำบล|เทศบาลตำบล|ทต\.)\s*(?:' + '|'.join(map(re.escape, var[n])) + r')') for n in names}
    moo_pat = re.compile(r'(?:หมู่(?:ที่)?|ม\.)\s*(\d{1,2})(?!\d)')
    pos = collections.Counter()
    geo = []
    for p in places:
        g = wkb.loads(p['geometry']).centroid
        geo.append(g); pos[(round(g.x, 5), round(g.y, 5))] += 1
    pts = []
    for p, g in zip(places, geo):
        if pos[(round(g.x, 5), round(g.y, 5))] >= 3 or not district.buffer(0.005).contains(g):
            continue
        nm = (p['names'] or {}).get('primary') or ''
        addr = ' ; '.join(' '.join(x for x in [a.get('freeform'), a.get('locality')] if x) for a in (p['addresses'] or []))
        t = nm + ' | ' + addr
        hit = [n for n in names if pats[n].search(t)]
        if len(hit) != 1:
            continue
        mm = moo_pat.search(addr) or moo_pat.search(nm)
        pts.append({'th': hit[0], 'moo': int(mm.group(1)) if mm else None, 'x': g.x, 'y': g.y, 'name': nm})
    print('จุดที่ระบุตำบล', len(pts), file=sys.stderr)

    # ---- 2) ปรับแนวเขต ----
    S = 0.001
    x0, y0, x1, y1 = district.bounds
    nx, ny = int((x1 - x0) / S) + 1, int((y1 - y0) / S) + 1
    bucket = collections.defaultdict(list)
    for q in pts:
        bucket[(int((q['x'] - x0) / S) // 6, int((q['y'] - y0) / S) // 6)].append(q)
    near_orig = {n: orig[n].buffer(1.5 / KX) for n in names}
    lab = {}
    changed = 0
    from shapely.prepared import prep
    pd = prep(district)
    po = {n: prep(orig[n]) for n in names}
    pn = {n: prep(near_orig[n]) for n in names}
    for j in range(ny):
        for i in range(nx):
            c = Point(x0 + (i + 0.5) * S, y0 + (j + 0.5) * S)
            if not pd.contains(c):
                continue
            o = next((n for n in names if po[n].contains(c)), None)
            votes = collections.Counter()
            if o: votes[o] += 1.0                                   # แนวเขตเดิมเป็นค่าตั้งต้น
            bi, bj = i // 6, j // 6
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    for q in bucket.get((bi + di, bj + dj), []):
                        d = km((c.x, c.y), (q['x'], q['y']))
                        if d < 0.6:
                            votes[q['th']] += math.exp(-(d / 0.25) ** 2)
            best = votes.most_common(2)
            L = best[0][0] if best else o
            if L != o and best[0][1] >= 1.2 and (len(best) < 2 or best[0][1] >= 1.5 * best[1][1]) and pn[L].contains(c):
                lab[(i, j)] = L; changed += 1
            else:
                lab[(i, j)] = o or L
    # เกลี่ยขอบ 2 รอบ
    for _ in range(2):
        nl = dict(lab)
        for (i, j), L in lab.items():
            cnt = collections.Counter(lab.get((i + a, j + b)) for a in (-1, 0, 1) for b in (-1, 0, 1))
            cnt.pop(None, None)
            top, k = cnt.most_common(1)[0]
            if top != L and k >= 6:
                nl[(i, j)] = top
        lab = nl
    print('เซลล์ที่ย้ายตำบล', changed, 'จาก', len(lab), file=sys.stderr)
    cells = collections.defaultdict(list)
    for (i, j), L in lab.items():
        if L: cells[L].append(box(x0 + i * S, y0 + j * S, x0 + (i + 1) * S, y0 + (j + 1) * S))
    # รูปร่างใหม่ = เดิม ปรับเฉพาะเซลล์ที่ย้าย (ขอบที่ไม่เปลี่ยนคงความละเอียดเดิม)
    moved = collections.defaultdict(list)
    for (i, j), L in lab.items():
        c = Point(x0 + (i + 0.5) * S, y0 + (j + 0.5) * S)
        o = next((n for n in names if po[n].contains(c)), None)
        if L and L != o:
            moved[L].append((box(x0 + i * S, y0 + j * S, x0 + (i + 1) * S, y0 + (j + 1) * S), o))
    new = dict(orig)
    for L, items in moved.items():
        add = unary_union([b for b, _ in items]).intersection(district)
        for n in names:
            if n != L:
                new[n] = new[n].difference(add)
        new[L] = new[L].union(add)
    # เศษชิ้นเล็ก (< 0.1 ตร.กม.) คืนให้ตำบลข้างเคียงที่มีขอบติดยาวที่สุด
    def parts(g):
        return list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
    for _ in range(3):
        for n in names:
            ps = sorted(parts(new[n].buffer(0)), key=lambda p: -p.area)
            for p in ps[1:]:
                if p.area * KX * KY < 0.1:
                    share = {m2: p.buffer(2e-5).intersection(new[m2]).area for m2 in names if m2 != n}
                    nb = max(share, key=share.get)
                    if share[nb] > 0:   # ให้เฉพาะตำบลที่ติดกันจริง
                        new[n] = new[n].difference(p); new[nb] = new[nb].union(p)
    out_feats = []
    report = []
    for f in fc['features']:
        if f['properties']['role'] == 'banpong':
            n = f['properties']['th']
            g = new[n].buffer(0)
            if g.geom_type == 'MultiPolygon':   # ตัดเศษเส้นบาง (< 0.005 ตร.กม.) ที่เกิดจากการตัดต่อรูป
                keep = [q for q in g.geoms if q.area * KX * KY >= 0.005]
                g = unary_union(keep) if keep else g
            g = g.simplify(0.00012, preserve_topology=True)
            a0, a1 = orig[n].area * KX * KY, g.area * KX * KY
            report.append((n, round(a0, 1), round(a1, 1)))
            f = dict(f); f['geometry'] = mapping(g)
            f['geometry'] = json.loads(json.dumps(f['geometry']))
            if f['geometry']['type'] == 'Polygon':
                f['geometry'] = {'type': 'MultiPolygon', 'coordinates': [f['geometry']['coordinates']]}
            f['geometry']['coordinates'] = [[[[round(c[0], 5), round(c[1], 5)] for c in r] for r in poly] for poly in f['geometry']['coordinates']]
            f['properties'] = dict(f['properties'], areaKm2=round(a1, 2))
        out_feats.append(f)
    for r in report: print('พื้นที่', r, file=sys.stderr)
    for n in names:
        g = new[n].buffer(0)
        k = len(g.geoms) if g.geom_type == 'MultiPolygon' else 1
        if k > 1: print('⚠ หลายชิ้น', n, k, [round(q.area * KX * KY, 3) for q in g.geoms], file=sys.stderr)
    fc['features'] = out_feats
    head = src[:m.start(1)]
    if 'build_villages.py' not in head:
        head = head.replace('window.BANPONG_TAMBONS = ', '// แนวเขตระหว่างตำบลปรับด้วย tools/build_villages.py จากที่อยู่สถานที่ที่ระบุตำบล (Overture Maps)\nwindow.BANPONG_TAMBONS = ')
    open(os.path.join(ROOT, 'data/banpong-tambons.js'), 'w', encoding='utf8').write(head + json.dumps(fc, ensure_ascii=False, separators=(',', ':')) + src[m.end(1):])

    # ---- 3) ตำแหน่งหมู่บ้าน ----
    groups = collections.defaultdict(list)
    for q in pts:
        if q['moo'] and new[q['th']].buffer(0.003).contains(Point(q['x'], q['y'])):
            groups[(q['th'], q['moo'])].append(q)
    vill = {}
    for (n, mo), qs in sorted(groups.items()):
        med = min(qs, key=lambda a: sum(km((a['x'], a['y']), (b['x'], b['y'])) for b in qs))
        ds_ = sorted(km((med['x'], med['y']), (b['x'], b['y'])) for b in qs)
        spread = ds_[len(ds_) // 2] if len(ds_) > 1 else None
        p = Point(med['x'], med['y'])
        rp = river.interpolate(river.project(p))
        dr = km((p.x, p.y), (rp.x, rp.y))
        conf = 'high' if len(qs) >= 3 and (spread or 0) < 1.0 else 'medium' if len(qs) >= 2 and (spread or 0) < 1.5 else 'low'
        vill[n + '|' + str(mo)] = {
            'lon': round(med['x'], 5), 'lat': round(med['y'], 5), 'n': len(qs), 'spreadKm': None if spread is None else round(spread, 2),
            'riverKm': round(dr, 2), 'cls': 'river' if dr <= 0.7 else 'near' if dr <= 2.0 else 'far', 'conf': conf,
            'refs': [q['name'][:40] for q in sorted(qs, key=lambda a: km((med['x'], med['y']), (a['x'], a['y'])))[:3]]
        }
    with open(os.path.join(ROOT, 'data/banpong-villages.js'), 'w', encoding='utf8') as fo:
        fo.write('// ตำแหน่งหมู่บ้าน (หมู่ที่) อ.บ้านโป่ง โดยประมาณ — สร้างด้วย tools/build_villages.py\n'
                 '// จากที่อยู่ของสถานที่ใน Overture Maps (release 2026-09-23.1) ที่ระบุทั้งตำบลและหมู่ · ตำแหน่ง = จุดกลาง (medoid) ของสถานที่ในหมู่นั้น\n'
                 '// riverKm = ระยะถึงแนวแม่น้ำแม่กลอง · cls: river ≤ 0.7 กม., near ≤ 2 กม., far · conf: high/medium/low ตามจำนวนจุดและการกระจาย\n'
                 '// ยังไม่ได้ยืนยันกับพื้นที่ — ใช้เป็นค่าเริ่มต้นที่แก้ไขได้\n'
                 'window.BANPONG_VILLAGES = ' + json.dumps({'source': 'Overture Maps places 2026-09-23.1', 'items': vill}, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print('หมู่บ้าน', len(vill), collections.Counter(v['conf'] for v in vill.values()), round(time.time() - t0), 's', file=sys.stderr)


if __name__ == '__main__':
    main()
