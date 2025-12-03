#!/usr/bin/env python3
import sys, os
from PIL import Image, ImageChops

SRC = sys.argv[1] if len(sys.argv)>1 else 'ME.jpeg'
OUTDIR = sys.argv[2] if len(sys.argv)>2 else 'extension/icons'
SIZES = [16, 48, 128]

os.makedirs(OUTDIR, exist_ok=True)

img = Image.open(SRC).convert('RGBA')

# Remove near-white background: threshold by distance to white
pixels = img.load()
w, h = img.size
thr = 245  # per-channel threshold
alpha_thr = 10
for y in range(h):
    for x in range(w):
        r,g,b,a = pixels[x,y]
        if a < alpha_thr:
            continue
        if r >= thr and g >= thr and b >= thr:
            pixels[x,y] = (255,255,255,0)

# Trim transparent borders
bg = Image.new('RGBA', img.size, (0,0,0,0))
diff = ImageChops.difference(img, bg)
bbox = diff.getbbox()
if bbox:
    img = img.crop(bbox)

# Save master png
master_path = os.path.join(OUTDIR, 'icon_master.png')
img.save(master_path)

# Generate square canvas with padding
for size in SIZES:
    canvas = Image.new('RGBA', (size, size), (0,0,0,0))
    # fit img into size preserving aspect ratio with 8% padding
    scale = min((size*0.84)/img.width, (size*0.84)/img.height)
    nw, nh = max(1, int(img.width*scale)), max(1, int(img.height*scale))
    resized = img.resize((nw, nh), Image.LANCZOS)
    ox, oy = (size - nw)//2, (size - nh)//2
    canvas.paste(resized, (ox, oy), resized)
    canvas.save(os.path.join(OUTDIR, f'icon{size}.png'))

print('Icons written to', OUTDIR)
