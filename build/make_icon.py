"""Draws the original Excel Label Studio app icon (build/icon.png + build/icon.ico). Requires Pillow."""
import os
from PIL import Image, ImageDraw
here = os.path.dirname(os.path.abspath(__file__))
S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# background tile with vertical gradient
tile = Image.new('RGBA', (S, S))
td = ImageDraw.Draw(tile)
for y in range(S):
    t = y / S
    td.line([(0, y), (S, y)], fill=(int(31 + 10 * t), int(111 - 30 * t), int(235 - 40 * t), 255))
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=200, fill=255)
img.paste(tile, (0, 0), mask)
# white label (tag) with a notch hole
label = [(230, 300), (720, 300), (850, 512), (720, 724), (230, 724)]
d.polygon([(x + 10, y + 16) for x, y in label], fill=(10, 30, 70, 90))
d.polygon(label, fill=(255, 255, 255, 255))
d.ellipse([735, 482, 795, 542], fill=(31, 100, 220, 255))
# three "text" lines of different weight
d.rounded_rectangle([290, 380, 640, 440], radius=22, fill=(29, 36, 48, 255))
d.rounded_rectangle([290, 485, 600, 530], radius=18, fill=(29, 111, 235, 255))
d.rounded_rectangle([290, 575, 520, 615], radius=16, fill=(120, 130, 145, 255))
img.save(os.path.join(here, 'icon.png'))
img.save(os.path.join(here, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon written')
