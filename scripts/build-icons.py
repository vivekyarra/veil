"""Reproducible VEIL application icons; no external artwork or fonts."""

from pathlib import Path
from PIL import Image, ImageDraw

out = Path("app/assets")
out.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 504, 504), radius=104, fill="#10161e")
draw.polygon(
    [(256, 70), (426, 135), (405, 316), (256, 446), (107, 316), (86, 135)],
    fill="#263d29",
    outline="#b9f391",
    width=9,
)
draw.line([(170, 170), (256, 336), (342, 170)], fill="#b9f391", width=28, joint="curve")
image.save(out / "icon.png")
image.save(
    out / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
image.save(out / "icon.icns")
