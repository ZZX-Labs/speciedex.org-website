#!/usr/bin/env python3
from pathlib import Path
import json
from PIL import Image, ImageDraw

OUT=Path('static/images/taxonomy-classes')
SIZE=32
COLORS={
'plant':'#5f9f3a','fungi':'#a26a3d','bird':'#4f8fb8','fish':'#398fa3','mammal':'#9a6c55','reptile':'#73964a','amphibian':'#55a86c','crustacean':'#d26f59','insect':'#c6a23a','arachnid':'#805d9b','mollusk':'#c98b73','worm':'#b57e5b','echinoderm':'#d9806a','cnidarian':'#d55c88','sponge':'#d0a14e','algae':'#3f9d7a','protist':'#6d90b8','bacteria':'#8f68b0','archaea':'#8b5f92','virus':'#b64c5d','pollen':'#d5a630','coral':'#e06f63','plankton':'#4b9bb0','other':'#6f776f'}

def line(d,pts,w=2): d.line(pts,fill='white',width=w,joint='curve')
def circle(d,box,fill='white',outline=None,w=1): d.ellipse(box,fill=fill,outline=outline,width=w)
def poly(d,pts,fill='white'): d.polygon(pts,fill=fill)

def symbol(d,k):
    if k=='plant': poly(d,[(16,7),(24,10),(19,21),(10,24),(12,13)]); line(d,[(11,23),(21,11)],2)
    elif k=='fungi': d.pieslice((7,7,25,21),180,360,fill='white'); d.rectangle((14,16,18,25),fill='white')
    elif k=='bird': poly(d,[(7,20),(15,10),(24,12),(18,16),(24,20),(15,18)]); circle(d,(18,11,20,13),fill='#4f8fb8')
    elif k=='fish': circle(d,(8,11,22,21)); poly(d,[(8,16),(3,11),(3,21)]); circle(d,(18,14,20,16),fill='#398fa3')
    elif k=='mammal': circle(d,(12,14,20,22)); [circle(d,b) for b in [(7,9,12,14),(13,6,18,11),(20,9,25,14)]]
    elif k=='reptile': line(d,[(6,20),(10,12),(17,11),(23,16),(18,22),(11,21)],3); circle(d,(21,14,23,16))
    elif k=='amphibian': circle(d,(8,10,24,23)); circle(d,(9,7,14,12)); circle(d,(18,7,23,12)); line(d,[(9,22),(5,26)],2); line(d,[(23,22),(27,26)],2)
    elif k=='crustacean': circle(d,(10,12,22,23)); line(d,[(10,15),(5,10),(8,7)],2); line(d,[(22,15),(27,10),(24,7)],2); line(d,[(11,21),(6,25)],2); line(d,[(21,21),(26,25)],2)
    elif k=='insect': circle(d,(12,10,20,22)); circle(d,(13,6,19,12)); line(d,[(12,13),(6,9)],2); line(d,[(20,13),(26,9)],2); line(d,[(12,17),(5,17)],2); line(d,[(20,17),(27,17)],2)
    elif k=='arachnid': circle(d,(11,10,21,21)); circle(d,(13,7,19,12));
    elif k=='mollusk': circle(d,(8,8,24,24),outline='white',fill=None,w=2); d.arc((11,11,21,21),0,300,fill='white',width=2)
    elif k=='worm': line(d,[(5,19),(10,11),(16,21),(22,10),(27,17)],3)
    elif k=='echinoderm': poly(d,[(16,5),(19,12),(27,12),(21,17),(23,25),(16,20),(9,25),(11,17),(5,12),(13,12)])
    elif k=='cnidarian': d.pieslice((8,7,24,21),180,360,fill='white'); [line(d,[(x,16),(x-2,25)],2) for x in (11,15,19,23)]
    elif k=='sponge': poly(d,[(9,25),(10,9),(15,6),(18,10),(23,8),(24,25)]); [circle(d,(x,y,x+3,y+3),fill=COLORS[k]) for x,y in [(12,11),(18,13),(14,18),(20,20)]]
    elif k=='algae': line(d,[(16,26),(16,9)],2); line(d,[(16,14),(10,9)],2); line(d,[(16,17),(23,11)],2); line(d,[(16,21),(10,18)],2)
    elif k=='protist': poly(d,[(7,17),(9,10),(15,7),(23,10),(25,16),(21,24),(13,25),(8,22)]); circle(d,(14,13,18,17),fill=COLORS[k])
    elif k=='bacteria': d.rounded_rectangle((6,11,26,21),radius=5,fill='white'); [circle(d,(x,14,x+2,16),fill=COLORS[k]) for x in (10,15,20)]
    elif k=='archaea': d.regular_polygon((16,16,10),6,rotation=30,fill='white'); d.regular_polygon((16,16,5),6,rotation=30,fill=COLORS[k])
    elif k=='virus': circle(d,(10,10,22,22));
    elif k=='pollen': circle(d,(9,9,23,23));
    elif k=='coral': line(d,[(16,26),(16,9)],3); line(d,[(16,15),(9,10)],3); line(d,[(16,18),(24,11)],3); line(d,[(16,22),(10,19)],3)
    elif k=='plankton': circle(d,(10,10,21,21)); line(d,[(20,14),(27,9),(25,18)],2); line(d,[(10,17),(5,24)],2)
    else: circle(d,(9,9,23,23),outline='white',fill=None,w=2); line(d,[(12,16),(20,16)],2)
    if k=='arachnid':
        for y,dy in [(11,-4),(15,0),(19,4)]: line(d,[(11,y),(5,y+dy)],2); line(d,[(21,y),(27,y+dy)],2)
    if k in {'virus','pollen'}:
        for dx,dy in [(0,-10),(0,10),(-10,0),(10,0),(-7,-7),(7,-7),(-7,7),(7,7)]: line(d,[(16+dx*.55,16+dy*.55),(16+dx,16+dy)],2)

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    manifest={'schema_version':1,'size':SIZE,'icons':{}}
    for key,color in COLORS.items():
        im=Image.new('RGBA',(SIZE,SIZE),(0,0,0,0)); d=ImageDraw.Draw(im)
        d.rounded_rectangle((1,1,SIZE-2,SIZE-2),radius=7,fill=color,outline=(0,0,0,210),width=1)
        symbol(d,key)
        p=OUT/f'{key}.png'; im.save(p,optimize=True)
        manifest['icons'][key]={'label':key.replace('-',' ').title(),'color':color,'path':'/'+p.as_posix()}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2,sort_keys=True)+'\n',encoding='utf-8')
    print(f'Wrote {len(COLORS)} class icons to {OUT}.')
if __name__=='__main__': main()
