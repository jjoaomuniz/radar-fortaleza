import json, csv, math, re, sys, unicodedata, collections
D = sys.argv[1]
# --- UTM zone 24S (SIRGAS2000 ~ WGS84) forward projection
a=6378137.0; f=1/298.257222101; e2=f*(2-f); k0=0.9996; lon0=math.radians(-39)
ep2=e2/(1-e2)
def fwd(lat,lon):
    p=math.radians(lat); l=math.radians(lon)
    N=a/math.sqrt(1-e2*math.sin(p)**2); T=math.tan(p)**2; C=ep2*math.cos(p)**2; A=math.cos(p)*(l-lon0)
    M=a*((1-e2/4-3*e2**2/64-5*e2**3/256)*p-(3*e2/8+3*e2**2/32+45*e2**3/1024)*math.sin(2*p)+(15*e2**2/256+45*e2**3/1024)*math.sin(4*p)-(35*e2**3/3072)*math.sin(6*p))
    x=k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T*T+72*C-58*ep2)*A**5/120)+500000
    y=k0*(M+N*math.tan(p)*(A*A/2+(5-T+9*C+4*C*C)*A**4/24+(61-58*T+T*T+600*C-330*ep2)*A**6/720))+10000000
    return x,y
def norm(s):
    s=unicodedata.normalize('NFKD',s or '').encode('ascii','ignore').decode().lower()
    s=re.sub(r'\[.*?\]|\(.*?\)','',s)
    for a_,b in [(r'\bav\.?\b','avenida'),(r'\br\.?\b','rua'),(r'\bpres\.?\b','presidente'),(r'\bdr\.?\b','doutor'),(r'\bsen\.?\b','senador'),(r'\bdes\.?\b','desembargador'),(r'\beng\.?\b','engenheiro'),(r'\bgal\.?\b','general'),(r'\bmal\.?\b','marechal'),(r'\bcel\.?\b','coronel'),(r'\bprof\.?\b','professor'),(r'\bpe\.?\b','padre'),(r'\bmons\.?\b','monsenhor'),(r'\bdep\.?\b','deputado'),(r'\bgov\.?\b','governador')]:
        s=re.sub(a_,b,s)
    s=re.sub(r'[^a-z0-9 ]',' ',s)
    stop={'avenida','rua','de','da','do','das','dos','e','travessa','alameda','trecho','via','expressa','br','ce'}
    return {w for w in s.split() if w not in stop and len(w)>1}
def parse_wkt(w):
    return [[tuple(map(float,pt.split())) for pt in part.split(',')] for part in re.findall(r'\(([^()]+)\)', w)]
segs=[]  # (speed, via, trecho, lines)
for fn,spd in [('v30.csv',30),('v40.csv',40)]:
    with open(f'{D}/{fn}',encoding='utf-8-sig') as fh:
        for r in csv.DictReader(fh,delimiter=';'):
            if r.get('Status','Implantado')!='Implantado': continue
            segs.append((int(r['Velocidade'] or spd),r['Via'],r['Trecho'],parse_wkt(r['geometry'])))
for ft in json.load(open(f'{D}/v50.geojson'))['features']:
    p=ft['properties']; segs.append((50,p['Via'],p['Trecho'],ft['geometry']['coordinates']))
def dseg(px,py,ax,ay,bx,by):
    dx,dy=bx-ax,by-ay; L=dx*dx+dy*dy
    t=0 if L==0 else max(0,min(1,((px-ax)*dx+(py-ay)*dy)/L))
    return math.hypot(px-(ax+t*dx),py-(ay+t*dy))
def dist(x,y,lines):
    return min(dseg(x,y,*l[i],*l[i+1]) for l in lines for i in range(len(l)-1))
out=[]; stats=collections.Counter()
for ft in json.load(open(f'{D}/fisc.geojson'))['features']:
    p=ft['properties']; lon,lat=ft['geometry']['coordinates']; x,y=fwd(lat,lon)
    via=p['ViaSentido'] or p['Endereco']; vn=norm(via.split(' x ')[0])
    best=None
    for spd,v,tr,lines in segs:
        d=dist(x,y,lines); nm=norm(v)
        match=bool(vn & nm) and (len(vn&nm)>=min(2,len(nm)) )
        if (match and d<40) or d<6:
            score=d-(100 if match else 0)
            if best is None or score<best[0]: best=(score,spd,v,tr,d,match)
    sentido=re.search(r'\[([^\]]+)\]',p['Endereco'] or '')
    rec=dict(id=p['Sitio'],via=re.sub(r'\s*\[.*?\]','',p['ViaSentido'] or '').strip(),endereco=re.sub(r'\s*\[.*?\]','',p['Endereco']).strip(),
             sentido=sentido.group(1) if sentido else None,bairro=p['Bairro'],lat=round(lat,6),lon=round(lon,6),
             faixas=p['Faixas_Fis'],desde=str(p['DataAtivacao']) if p['DataAtivacao'] else None,fonte='AMC')
    if best:
        rec.update(limite=best[1],limite_fonte='AMC vias %d km/h'%best[1]); stats[best[1]]+=1
    else:
        rec.update(limite=60,limite_fonte='padrao'); stats['60 (padrao)']+=1
    out.append(rec)
print(stats, file=sys.stderr)
json.dump(out,open(f'{D}/amc_radares.json','w'),ensure_ascii=False,indent=0)
