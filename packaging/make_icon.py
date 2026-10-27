"""Иконка приложения: синий ромб на тёмном скруглённом квадрате (packaging/app.ico)."""
from pathlib import Path

from PIL import Image, ImageDraw

S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((8, 8, S - 8, S - 8), radius=52, fill=(22, 24, 30, 255), outline=(60, 64, 76, 255), width=4)
c = S // 2
d.polygon([(c, 40), (S - 40, c), (c, S - 40), (40, c)], fill=(64, 132, 255, 255))
d.polygon([(c, 40), (S - 40, c), (c, c)], fill=(120, 170, 255, 255))
d.polygon([(c, 92), (S - 92, c), (c, S - 92), (92, c)], fill=(22, 24, 30, 255))
out = Path(__file__).with_name("app.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(out)
