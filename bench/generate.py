"""Render synthetic 1080p screens and DOM-derived truth, never actual desktop data."""

import argparse
import json
import random
from pathlib import Path
from faker import Faker
from playwright.sync_api import sync_playwright

FONTS = [
    "Arial",
    "Verdana",
    "Georgia",
    "Times New Roman",
    "Courier New",
    "Trebuchet MS",
    "Tahoma",
    "Consolas",
]


def generate(count: int, output: Path, seed: int) -> None:
    """Save deterministic diverse fixtures and a JSONL manifest."""
    output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    fake = Faker()
    fake.seed_instance(seed)
    records = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(
            viewport={"width": 1920, "height": 1080}, device_scale_factor=1
        )
        for i in range(count):
            kind = ["email", "card", "secret", "vault", "phone", "address", "negative"][
                i % 7
            ]
            values = {
                "email": f"{fake.user_name()}@example.com",
                "card": "4111 1111 1111 1111",
                "secret": "api_key=synthetic_" + fake.pystr(min_chars=24, max_chars=24),
                "vault": "Synthetic Maple Academy",
                "phone": "+1 202 555 0100",
                "address": f"{100 + i % 800} Synthetic Maple Street",
                "negative": f"SCORE {rng.randrange(100, 9999)}  |  FPS 60  |  ROUND {i % 20}",
            }
            family = FONTS[i % len(FONTS)]
            size = [11, 14, 18, 22, 28][i % 5]
            scale = [1, 1.25, 1.5, 2][i % 4]
            dark = i % 2 == 0
            surface = [
                "Inbox — synthetic mail",
                "Direct messages — rehearsal",
                "Browser — example.com",
                "Terminal — synthetic shell",
                "Address form",
                "Account settings",
                "Arena scoreboard",
            ][i % 7]
            x, y = rng.randint(70, 850), rng.randint(150, 750)
            html = f"""<!doctype html><html><meta charset="utf-8"><body style="margin:0;background:{"#0d1220" if dark else "#eef2f8"};color:{"#f2f5ff" if dark else "#101627"};font-family:'{family}';"><header style="padding:28px;border-bottom:1px solid #64748b;font-size:22px">VEIL REHEARSAL / {surface}</header><aside style="padding:24px;color:#8796ae">All content is synthetic • local-only fixture • example.com</aside><main style="position:absolute;left:{x}px;top:{y}px;padding:32px;background:{"#202b40" if dark else "#fff"};border:1px solid #66728b;border-radius:12px"><p>Preview / test account</p><span id="sensitive" style="font-size:{size * scale}px;filter:blur({".25" if i % 13 == 0 else "0"}px)">{values[kind]}</span><p style="color:#94a3b8">Synthetic fixture {i:05d}</p></main></body></html>"""
            page.set_content(html)
            box = page.locator("#sensitive").bounding_box()
            name = f"{i:05d}.{'jpg' if i % 3 == 0 else 'png'}"
            options = {"quality": 75 + i % 20} if name.endswith("jpg") else {}
            page.screenshot(
                path=str(output / name),
                type="jpeg" if name.endswith("jpg") else "png",
                **options,
            )
            records.append(
                {
                    "file": name,
                    "kind": kind,
                    "box": box,
                    "font": family,
                    "font_size": size,
                    "scale": scale,
                    "vault": [values["vault"]],
                }
            )
        browser.close()
    (output / "manifest.jsonl").write_text(
        "\n".join(json.dumps(r) for r in records), encoding="utf-8"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=3000)
    parser.add_argument("--output", type=Path, default=Path("bench/data"))
    parser.add_argument("--seed", type=int, default=7319)
    args = parser.parse_args()
    generate(args.count, args.output, args.seed)
