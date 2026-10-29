"""Create independently specified synthetic cross-language cases."""
import json
from pathlib import Path

pairs = [
    ("123 Main St", "1 2 3 m4in st", True),
    ("alice", "аlісе", True),
    ("sunflower", "sunflwoer", True),
    ("5550100", "555-0100", True),
    ("abc", "axc", False),
    ("sunflower", "sxfloqer", False),
    ("", "hello", False),
    ("alice", "ＡＬＩＣＥ", True),
    ("private", "pri\u200bvate", True),
    ("secrets", "s3cr3ts", True),
    ("alice", "АLІСЕ", True),
    ("synthetic", "s\u2060ynthetic", True),
    ("école synthétique", "école synthétique", True),
    ("देवपरीक्षा", "देवपरीक्षा", True),
    ("架空学院甲", "架空学院甲", True),
    ("架空学院甲", "架空学院乙", False),
    ("𐐀𐐁𐐂𐐃𐐄", "𐐀𐐁𐐂𐐃𐐅", False),
    ("abcdef", "abcedf", True),
    ("abcdef", "abcxef", True),
    ("abcdef", "abcef", True),
    ("abcdef", "abcxdef", True),
    ("abcdef", "abxxef", False),
    ("5550100", "555 0101", False),
    ("mainst", "ｍａｉｎｓｔ", True),
    ("a b", "a\u200db", True),
    ("5550100", "٥٥٥٠١٠٠", True),
]
cases = [{"term": a, "message": f"{prefix}{b}{suffix}", "match": expected}
         for a, b, expected in pairs
         for prefix, suffix in [("", ""), ("hey ", " today"), ("<emote>", "</emote>"), ("---", "!!!"), ("\u200b", "\u200b"), ("  ", " "), ("notice: ", "."), ("chat ", " chat")]]
Path("shared/normalization-cases.json").write_text(json.dumps(cases, ensure_ascii=False, indent=2), encoding="utf-8")
