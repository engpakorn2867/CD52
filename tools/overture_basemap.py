#!/usr/bin/env python3
# สร้าง data/banpong-basemap.js และปรับขอบนอกตำบลใน data/banpong-tambons.js ให้ตรงขอบอำเภอ
# จากข้อมูล Overture Maps (S3 สาธารณะ, ไม่ต้องใช้บัญชี)
# ใช้งาน: pip install pyarrow shapely && python3 tools/overture_basemap.py
import os, sys, json, re, time, collections
import pyarrow.dataset as ds, pyarrow.fs as pfs, pyarrow.compute as pc
from shapely import wkb
from shapely.geometry import shape, box
from shapely.ops import unary_union

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
REL = 'overturemaps-us-west-2/release/2026-09-23.1'
B = (99.56, 13.70, 100.00, 14.00)  # lon/lat กรอบ อ.บ้านโป่งและรอบข้าง
proxy = os.environ.get('HTTPS_PROXY')
fs = pfs.S3FileSystem(anonymous=True, region='us-west-2', **({'proxy_options': proxy} if proxy else {}))

def read(theme, typ, cols, extra=None):
    t = time.time()
    d = ds.dataset(f'{REL}/theme={theme}/type={typ}/', filesystem=fs, format='parquet')
    f = (pc.field('bbox', 'xmin') < B[2]) & (pc.field('bbox', 'xmax') > B[0]) & (pc.field('bbox', 'ymin') < B[3]) & (pc.field('bbox', 'ymax') > B[1])
    if extra is not None: f = f & extra
    tb = d.to_table(columns=cols, filter=f)
    print(theme, typ, tb.num_rows, 'rows', round(time.time() - t), 's', file=sys.stderr)
    return tb

def col(tb, c): return tb.column(c).to_pylist()
def name(n): return (n or {}).get('primary')

def fetch():
    out = {}
    div = read('divisions', 'division_area', ['names', 'subtype', 'geometry'], pc.field('subtype') == 'county')
    out['districts'] = [(name(n), wkb.loads(g)) for n, g in zip(col(div, 'names'), col(div, 'geometry'))]
    seg = read('transportation', 'segment', ['class', 'names', 'geometry'], pc.field('subtype') == 'road')
    out['roads'] = [(c, name(n), wkb.loads(g)) for c, n, g in zip(col(seg, 'class'), col(seg, 'names'), col(seg, 'geometry'))]
    w = read('base', 'water', ['subtype', 'class', 'names', 'geometry'])
    out['water'] = [(s, c, name(n), wkb.loads(g)) for s, c, n, g in zip(col(w, 'subtype'), col(w, 'class'), col(w, 'names'), col(w, 'geometry'))]
    dv = read('divisions', 'division', ['names', 'subtype', 'class', 'geometry'])
    out['localities'] = [(s, c, name(n), wkb.loads(g)) for n, s, c, g in zip(col(dv, 'names'), col(dv, 'subtype'), col(dv, 'class'), col(dv, 'geometry'))]
    pl = read('places', 'place', ['names', 'basic_category', 'confidence', 'geometry'], pc.field('confidence') > 0.8)
    out['places'] = [(name(n), c, cf, wkb.loads(g)) for n, c, cf, g in zip(col(pl, 'names'), col(pl, 'basic_category'), col(pl, 'confidence'), col(pl, 'geometry'))]
    return out

def fix_tambons(d):
    src=open(os.path.join(ROOT,'data/banpong-tambons.js')).read()
    fc=json.loads(re.search(r'window\.BANPONG_TAMBONS = (\{.*\});', src, re.S).group(1))
    bp_district=[g for n,g in d['districts'] if n=='Ban Pong'][0]
    print('district area km2 ~', round(bp_district.area*111*108,1))
    bp=[f for f in fc['features'] if f['properties']['role']=='banpong']
    geoms={f['properties']['th']:shape(f['geometry']).buffer(0) for f in bp}
    # 1) ตัดให้อยู่ในขอบอำเภอ
    clip={k:g.intersection(bp_district) for k,g in geoms.items()}
    # 2) เติมช่องว่างในอำเภอที่ไม่มีตำบลใดครอบ ให้ตำบลที่ใกล้ที่สุด (แบ่งช่องว่างเป็นชิ้นย่อยตามกริด)
    gap=bp_district.difference(unary_union(list(clip.values())))
    print('gap km2', round(gap.area*111*108,2))
    minx,miny,maxx,maxy=gap.bounds; step=0.004
    x=minx
    pieces={k:[] for k in clip}
    while x<maxx:
        y=miny
        while y<maxy:
            cell=gap.intersection(box(x,y,x+step,y+step))
            if not cell.is_empty:
                c=cell.representative_point()
                k=min(clip, key=lambda k: clip[k].distance(c))
                pieces[k].append(cell)
            y+=step
        x+=step
    out=[]
    for f in fc['features']:
        p=f['properties']
        if p['role']=='banpong':
            g=unary_union([clip[p['th']]]+pieces[p['th']]).buffer(0)
            g=g.simplify(0.00005)
            polys=[g] if g.geom_type=='Polygon' else [q for q in getattr(g,'geoms',[]) if q.geom_type=='Polygon']
            polys=[q for q in polys if q.area*111*108>0.01]
            f['geometry']={'type':'MultiPolygon','coordinates':[[[[round(a,5),round(b,5)] for a,b in ring.coords] for ring in [q.exterior]+list(q.interiors)] for q in polys]}
            p['areaKm2']=round(g.area*111.32*110.57*0.971,2)
        out.append(f)
    fc['features']=out
    open(os.path.join(ROOT,'data/banpong-tambons.js'),'w').write(
    "// ขอบเขตตำบล อ.บ้านโป่ง จ.ราชบุรี (role: banpong) และตำบลข้างเคียง (role: context)\n"
    "// ที่มา: OpenGISData-Thailand (github.com/chingchai/OpenGISData-Thailand, subdistricts.geojson) — ขอบเขตแบบย่อ (ไม่ใช่แนวเขตทางกฎหมาย)\n"
    "// ตำบลในอำเภอบ้านโป่งถูกตัด/เติมให้ขอบนอกตรงกับขอบอำเภอจาก Overture Maps divisions (© OpenStreetMap contributors, ODbL)\n"
    "window.BANPONG_TAMBONS = "+json.dumps(fc,ensure_ascii=False,separators=(',',':'))+";\n")
    print({f['properties']['th']:f['properties']['areaKm2'] for f in out if f['properties']['role']=='banpong'})

def build_basemap(d):
    Q=1e5
    def enc(coords):
        out=[];px=py=0
        for x,y in coords:
            X=round(x*Q);Y=round(y*Q);out+= [X-px,Y-py];px,py=X,Y
        return out
    def lines(g,tol):
        g=g.simplify(tol)
        if g.is_empty: return []
        if g.geom_type=='LineString': return [enc(g.coords)]
        if g.geom_type=='MultiLineString': return [enc(l.coords) for l in g.geoms]
        return []
    def polys(g,tol):
        g=g.simplify(tol)
        ps=[g] if g.geom_type=='Polygon' else list(getattr(g,'geoms',[]))
        return [[enc(p.exterior.coords)]+[enc(i.coords) for i in p.interiors] for p in ps if p.geom_type=='Polygon']
    CL={'motorway':'major','trunk':'major','primary':'major','secondary':'secondary','tertiary':'tertiary'}
    roads={'major':[],'secondary':[],'tertiary':[],'minor':[]}
    names=[]
    for c,n,g in d['roads']:
        if c in ('footway','steps','path'): continue
        k=CL.get(c,'minor')
        roads[k]+=lines(g,0.00003)
        if n and k in ('major','secondary') and g.length>0.01:
            m=g.interpolate(0.5,normalized=True); a=g.interpolate(0.45,normalized=True); b=g.interpolate(0.55,normalized=True)
            names.append([n,round(m.x,5),round(m.y,5),round(b.x-a.x,6),round(b.y-a.y,6),k])
    water={'river':[],'area':[],'canal':[],'riverLine':[]}
    for s,c,n,g in d['water']:
        if g.geom_type in ('Polygon','MultiPolygon'):
            (water['river'] if (n and 'แม่กลอง' in n) else water['area']).extend(polys(g,0.00002))
        elif n and 'แม่กลอง' in n:
            water['riverLine']+=lines(g,0.00003)
        elif s in ('canal','stream','river'):
            water['canal']+=lines(g,0.00003)
    districts=[[n,polys(g,0.00003)] for n,g in d['districts']]
    labels=[]
    for s,c,n,g in d['localities']:
        if n and s=='locality': labels.append([n,round(g.x,5),round(g.y,5),c])
    KEEP={'buddhist_place_of_worship':'วัด','place_of_learning':'โรงเรียน','education':'โรงเรียน','hospital':'โรงพยาบาล','government_office':'ราชการ'}
    for n,c,cf,g in d['places']:
        if n and c in KEEP and g.geom_type=='Point': labels.append([n,round(g.x,5),round(g.y,5),KEEP[c]])
    base={'q':Q,'roads':roads,'roadNames':names,'water':water,'districts':districts,'labels':labels}
    s=json.dumps(base,ensure_ascii=False,separators=(',',':'))
    open(os.path.join(ROOT,'data/banpong-basemap.js'),'w').write(
    "// แผนที่พื้นฐาน อ.บ้านโป่งและรอบข้าง: ถนน แหล่งน้ำ ขอบเขตอำเภอ ชื่อชุมชน/สถานที่\n"
    "// ที่มา: Overture Maps Foundation release 2026-09-23.1 (transportation, base/water, divisions, places)\n"
    "// ข้อมูลถนน/แหล่งน้ำ/ขอบเขต © OpenStreetMap contributors (ODbL 1.0) · places: Overture (CDLA-Permissive-2.0)\n"
    "// พิกัดเก็บเป็นจำนวนเต็ม (องศา × q) แบบผลต่างสะสม — ถอดด้วย TambonMap.decode\n"
    "window.BANPONG_BASEMAP = "+s+";\n")
    print('bytes',len(s),{k:len(v) for k,v in roads.items()},'names',len(names),'labels',len(labels),{k:len(v) for k,v in water.items()})

if __name__ == '__main__':
    data = fetch()
    fix_tambons(data)
    build_basemap(data)
