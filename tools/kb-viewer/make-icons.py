# 从灵框主图标生成 PWA 图标集
from PIL import Image
import os

SRC = r'F:/OpenDesign/.od/projects/lingkuang-v3-ui/build/icon.png'
OUT = r'F:/OpenDesign/.od/projects/lingkuang-v3-ui/tools/kb-viewer/public/icons'
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert('RGBA')
w, h = im.size
print('src', w, h, 'corner px:', im.getpixel((0, 0)), im.getpixel((w - 1, h - 1)))

# 1) 非正方形 -> 居中补方（透明）
side = max(w, h)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(im, ((side - w) // 2, (side - h) // 2), im)

def save(img, name, size):
    img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name), 'PNG', optimize=True)
    print('  ->', name, size)

# 2) 常规图标
save(sq, 'icon-192.png', 192)
save(sq, 'icon-512.png', 512)
save(sq, 'apple-touch-icon.png', 180)
save(sq, 'favicon-32.png', 32)

# 3) maskable：深底(#0f0f11 荧光框) + 内容缩到 78% 保证安全区
M = 512
mask = Image.new('RGBA', (M, M), (15, 15, 17, 255))
inner = int(M * 0.78)
icon = sq.resize((inner, inner), Image.LANCZOS)
off = (M - inner) // 2
mask.paste(icon, (off, off), icon)
mask.save(os.path.join(OUT, 'icon-maskable-512.png'), 'PNG', optimize=True)
print('  -> icon-maskable-512.png 512')

print('DONE ->', OUT)
