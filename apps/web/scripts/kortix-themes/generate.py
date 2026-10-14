#!/usr/bin/env python3
"""Usage: python3 apps/web/scripts/kortix-themes/generate.py
Sources: palettes/<family>__<variant> files (Ghostty colour format) from https://terminalcolors.com/downloads/ghostty/<id>."""
"""Generate the Kortix themes from terminalcolors.com palettes.
Rule (terminal-faithful): sidebar == canvas; raised/card/hover/well/border derived in OKLCH at the
canvas hue; CTA = terminal fg; ANSI colours -> status hues, ring, links; every text/status pair
contrast-checked and nudged in OKLCH lightness until it passes."""
import json, math, re, os, html
S=os.path.dirname(os.path.abspath(__file__))
REPO=os.path.abspath(os.path.join(S,'..','..','..','..'))
def s2l(c): return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def l2s(c): return 12.92*c if c<=0.0031308 else 1.055*c**(1/2.4)-0.055
def h2r(h): return [int(h[i:i+2],16)/255 for i in (1,3,5)]
def r2h(r): return '#'+''.join('%02x'%round(max(0,min(1,c))*255) for c in r)
def oklch(h):
    r,g,b=[s2l(c) for c in h2r(h)]
    l=.4122214708*r+.5363325363*g+.0514459929*b; m=.2119034982*r+.6806995451*g+.1073969566*b; s=.0883024619*r+.2817188376*g+.6299787005*b
    l,m,s=[x**(1/3) for x in (l,m,s)]
    L=.2104542553*l+.7936177850*m-.0040720468*s; A=1.9779984951*l-2.4285922050*m+.4505937099*s; B=.0259040371*l+.7827717662*m-.8086757660*s
    return L, math.hypot(A,B), math.atan2(B,A)
def hexlch(L,C,H):
    L=max(0,min(1,L)); A,B=C*math.cos(H),C*math.sin(H)
    l=(L+.3963377774*A+.2158037573*B)**3; m=(L-.1055613458*A-.0638541728*B)**3; s=(L-.0894841775*A-1.2914855480*B)**3
    r=4.0767416621*l-3.3077115913*m+.2309699292*s; g=-1.2684380046*l+2.6097574011*m-.3413193965*s; b=-.0041960863*l-.7034186147*m+1.7076147010*s
    return r2h([l2s(max(0,min(1,c))) for c in (r,g,b)])
def lum(h): r,g,b=[s2l(c) for c in h2r(h)]; return .2126*r+.7152*g+.0722*b
def cr(a,b): a,b=lum(a),lum(b); return (max(a,b)+.05)/(min(a,b)+.05)
def mix(a,b,t): return r2h([x*(1-t)+y*t for x,y in zip(h2r(a),h2r(b))])
def rgba(h,a): r,g,b=[int(h[i:i+2],16) for i in (1,3,5)]; return f'rgba({r}, {g}, {b}, {a})'
def ensure(col, bgs, target, dark):
    """Nudge col's OKLCH lightness away from the backgrounds until it clears target on all."""
    L,C,H=oklch(col); c=col
    for _ in range(80):
        if min(cr(c,b) for b in bgs)>=target: return c
        L+= 0.01 if dark else -0.01; c=hexlch(L,C,H)
    return c
def parse(path):
    d={'palette':{}}
    for line in open(path):
        m=re.match(r'\s*([a-z-]+)\s*=\s*(.+?)\s*$',line)
        if not m: continue
        k,v=m.groups()
        if k=='palette': i,c=v.split('='); d['palette'][int(i)]=c.strip().lower()
        else: d[k]=v.lower()
    return d
SPECIAL={'frappe':'Frappé','dark-dimmed':'Dark Dimmed','dark-high-contrast':'Dark High Contrast'}
def titleize(s): return SPECIAL.get(s) or ' '.join(w.capitalize() for w in s.split('-'))
rows=[]
NAMES=json.load(open(os.path.join(S,'family-names.json')))
for line in open(os.path.join(S,'sources.txt')):
    v,dl=line.rstrip('\n').split('|')
    fam,var=v.split('__'); gfile=os.path.join(S,'palettes',v); t=parse(gfile)
    famname=NAMES[v.split('__')[0]]
    tid=dl.split('/')[-1].lower()
    name=famname if var=='default' else f'{famname} {titleize(var)}'
    bg,fg=t['background'],t['foreground']; p=t['palette']
    L,C,H=oklch(bg); dark=L<0.6; s=1 if dark else -1
    sh=lambda dl,c=C: hexlch(L+dl,c,H)
    if dark: card,surface,hover,well,border=sh(.025),sh(.04),sh(.065),sh(.08),sh(.105)
    else: card,surface,hover,well,border=sh(-.025),hexlch(min(.99,L+.04),C*.6,H),sh(-.035),sh(-.05),sh(-.085)
    ink=ensure(fg,[bg,well,surface],7.0,dark)
    tt=0
    while cr(mix(ink,bg,tt+0.02),well)>=5.0 and cr(mix(ink,bg,tt+0.02),bg)>=5.0 and tt<0.6: tt+=0.02
    muted=mix(ink,bg,tt)
    def ansi(i,j): 
        a=p.get(i) or p.get(j) or ink
        return ensure(a,[bg,card],3.0,dark)
    blue,green,red,yellow,purple=ansi(4,12),ansi(2,10),ansi(1,9),ansi(3,11),ansi(5,13)
    orange=ensure(t.get('cursor-color') if t.get('cursor-color') and t['cursor-color'] not in (fg,bg) else (p.get(11) or p.get(3)),[bg,card],3.0,dark)
    sel=t.get('selection-background') or mix(blue,bg,0.7)
    selfg=t.get('selection-foreground') or ink
    if cr(selfg,sel)<4.5: selfg=ink if cr(ink,sel)>=cr(bg,sel) else bg
    destfg = bg if cr(bg,red)>=cr('#fbfbfb',red) else '#fbfbfb'
    ringfg = bg if cr(bg,blue)>=cr('#ffffff',blue) else '#ffffff'
    tok={'background':bg,'foreground':ink,'pane':bg,'surface':surface,'card':card,'card-foreground':ink,'popover':surface,'popover-foreground':ink,
     'primary':ink,'primary-foreground':bg,'secondary':well,'secondary-foreground':ink,'muted':well,'muted-foreground':muted,'accent':hover,'accent-foreground':ink,
     'destructive':red,'destructive-foreground':destfg,'border':border,'input':well,'ring':blue,'hover':rgba(ink,'0.06' if dark else '0.045'),'active':rgba(ink,'0.1' if dark else '0.075'),
     'selection':sel,'selection-foreground':selfg,'sidebar':bg,'sidebar-foreground':ink,'sidebar-primary':blue,'sidebar-primary-foreground':ringfg,'sidebar-accent':well,
     'sidebar-accent-foreground':ink,'sidebar-border':border,'sidebar-ring':blue,'kortix-blue':blue,'kortix-green':green,'kortix-red':red,'kortix-yellow':yellow,'kortix-orange':orange,'kortix-purple':purple}
    checks=dict(ink=cr(ink,bg),muted_bg=cr(muted,bg),muted_well=cr(muted,well),input_surface=round(cr(well,surface),2),ring=cr(blue,bg))
    rows.append(dict(id=tid,name=name,family=fam,familyName=famname,variant=var,mode='dark' if dark else 'light',tokens=tok,checks={k:round(v,2) for k,v in checks.items()}))
rows.sort(key=lambda r:(r['familyName'].lower(), r['variant']!='default', r['name'].lower()))
ids=[r['id'] for r in rows]; assert len(ids)==len(set(ids)); RESERVED={'light','pure-light','dark','pure-dark','system'}; assert not RESERVED&set(ids)
ORDER=list(rows[0]['tokens'])
css=['/*','  GENERATED by apps/web/scripts/kortix-themes/generate.py from terminalcolors.com palettes. Do not edit by hand.',
 '  Each block declares all 39 interface tokens (see globals.css "Interface themes"). Light blocks are scoped',
 '  :root:not(.dark) so a stored light choice never leaks into dark mode.','*/','']
for r in rows:
    sel=(f":root:not(.dark)[data-light-theme='{r['id']}']" if r['mode']=='light' else f":root.dark[data-dark-theme='{r['id']}']")
    css.append(f"/* {r['name']} */\n{sel},\n[data-theme-preview='{r['id']}'] {{\n  color-scheme: {r['mode']};\n"+''.join(f"  --{k}: {r['tokens'][k]};\n" for k in ORDER)+"}\n")
open(f'{REPO}/apps/web/src/app/kortix-themes.generated.css','w').write('\n'.join(css))
meta=[dict(id=r['id'],name=r['name'],family=r['family'],familyName=r['familyName'],mode=r['mode'],background=r['tokens']['background'],foreground=r['tokens']['foreground'],accent=r['tokens']['ring']) for r in rows]
open(f'{REPO}/apps/web/src/lib/kortix-themes.generated.json','w').write(json.dumps(meta,indent=2)+'\n')
open(f'{REPO}/apps/desktop-electron/src/kortix-theme-backgrounds.json','w').write(json.dumps({m:{r['id']:r['tokens']['background'].upper() for r in rows if r['mode']==m} for m in ('light','dark')},indent=2)+'\n')
bad=[(r['id'],r['checks']) for r in rows if r['checks']['ink']<7 or r['checks']['muted_bg']<4.5 or r['checks']['muted_well']<4.5 or r['checks']['ring']<3]
print(len(rows),'themes;',sum(r['mode']=='light' for r in rows),'light;',sum(r['mode']=='dark' for r in rows),'dark; failing checks:',bad)
print([ (r['id'],r['name']) for r in rows[:6]])
