"""Reject incomplete production code and committed secrets."""
import pathlib
import re
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
files = subprocess.check_output(["git", "ls-files"], cwd=root, text=True).splitlines()
errors = []
for name in files:
    path = root / name
    if path.name == ".env":
        errors.append(name)
    if name.startswith("plugin/cmake/") or name.startswith("plugin/build-aux/"):
        continue
    if path.suffix not in {".py", ".ts", ".tsx", ".cts", ".mjs", ".cpp", ".c", ".h"} or name == "scripts/check-crumbs.py":
        continue
    source = path.read_text(encoding="utf-8")
    pattern = r"\b(?:TO" + r"DO|FIX" + r"ME|XX" + r"X|HA" + r"CK)\b|console\.log\(|\.(?:skip|only)\("
    if re.search(pattern, source):
        errors.append(name)
    if name.startswith("detector/veil_detector/") and re.search(r"\bprint\s*\(", source):
        errors.append(name)
if errors:
    raise SystemExit("Incomplete code or secrets: " + ", ".join(errors))
