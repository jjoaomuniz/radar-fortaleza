import json, math, re, sys, unicodedata, collections
D=sys.argv[1]
def xy(lat,lon): return (lon*111320*math.cos(math.radians(-3.75)), lat*110574)
def dseg(p,a,b):
    dx,dy=b[0]-a[0],b[1]-a[1]; L=dx*dx+dy*dy
    t=0 if L==0 else max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L))
    return math.hypot(p[0]-(a[0]+t*dx),p[1]-(a[1]+t*dy))
def norm(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    s=re.sub(r'[^a-z0-9 ]',' ',s); return {w for w in s.split() if len(w)>3}
def spd(v):
    m=re.match(r'^\s*(\d+)',v or ''); return int(m.group(1)) if m else None
amc=json.load(open(f'{D}/amc_radares.json'))
cams=[e for e in json.load(open(f'{D}/osm.json'))['elements']]
ways=[w for w in json.load(open(f'{D}/ways.json'))['elements'] if w.get('geometry')]
for w in ways: w['_xy']=[xy(g['lat'],g['lon']) for g in w['geometry']]
def wdist(p,w): return min(dseg(p,w['_xy'][i],w['_xy'][i+1]) for i in range(len(w['_xy'])-1))
rank={'motorway':0,'trunk':1,'primary':2,'secondary':3,'tertiary':4,'unclassified':5,'residential':6}
def near_ways(p,r): 
    out=[(wdist(p,w),w) for w in ways]; return sorted([o for o in out if o[0]<=r],key=lambda o:o[0])
st=collections.Counter()
for r in amc:
    r['limite_oficial']=r['limite_fonte']!='padrao'
    if r['limite_oficial']: r['limite_fonte']='AMC'; st['amc']+=1; continue
    p=xy(r['lat'],r['lon']); lim=None; src=None
    cs=sorted((math.dist(p,xy(c['lat'],c['lon'])),c) for c in cams if spd(c.get('tags',{}).get('maxspeed')))
    if cs and cs[0][0]<40: lim=spd(cs[0][1]['tags']['maxspeed']); src='OSM radar'
    if lim is None:
        vn=norm(r['via'])
        for d,w in near_ways(p,25):
            if spd(w['tags'].get('maxspeed')) and (vn & norm(w['tags'].get('name'))):
                lim=spd(w['tags']['maxspeed']); src='OSM via'; break
    r['limite']=lim; r['limite_fonte']=src; st[src]+=1
    print('  ',lim,src,'|',r['endereco'],file=sys.stderr)
print('AMC limites:',st,file=sys.stderr)
amcxy=[xy(r['lat'],r['lon']) for r in amc]
extra=[]; st2=collections.Counter()
for c in cams:
    p=xy(c['lat'],c['lon']); t=c.get('tags',{})
    if min(math.dist(p,q) for q in amcxy)<60: st2['dup AMC']+=1; continue
    nw=near_ways(p,30)
    major=sorted([o for o in nw if o[1]['tags'].get('highway','').replace('_link','') in rank],key=lambda o:(o[0]>12, rank.get(o[1]['tags']['highway'].replace('_link',''),9), o[0]))
    w=major[0][1]['tags'] if major else {}
    nome=w.get('name'); ref=w.get('ref') or t.get('ref')
    label=' / '.join(x for x in [ref, nome] if x) or 'Radar (sem nome de via)'
    lim=spd(t.get('maxspeed')); src='OSM radar' if lim else None
    if lim is None and spd(w.get('maxspeed')): lim=spd(w['maxspeed']); src='OSM via'
    st2[src]+=1
    extra.append(dict(id='osm'+str(c['id']),via=label,endereco=label,sentido=None,bairro=None,lat=round(c['lat'],6),lon=round(c['lon'],6),
        faixas=None,desde=None,fonte='OSM',limite=lim,limite_fonte=src,limite_oficial=False))
print('OSM extras:',len(extra),st2,file=sys.stderr)
allr=amc+extra
for r in allr: r.pop('faixas',None)
json.dump({'gerado':'2026-11-02','fontes':{
  'AMC':'Portal de Dados Abertos de Fortaleza — Fiscalização Eletrônica (AMC), atualizado 22/07/2025; limites: datasets Vias 30/40/50 (AMC)',
  'OSM':'OpenStreetMap (highway=speed_camera), dados colaborativos, © contribuidores OpenStreetMap, ODbL'},
  'radares':allr},open(f'{D}/radares.json','w'),ensure_ascii=False,separators=(',',':'))
print('total',len(allr),file=sys.stderr)
