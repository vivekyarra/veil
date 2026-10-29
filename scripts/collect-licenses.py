"""Retain installed distribution license/notice files with frozen artifacts."""

from importlib.metadata import distributions
from pathlib import Path
import shutil

output = Path("detector/dist/veil-detector/licenses")
output.mkdir(parents=True, exist_ok=True)
inventory = []
for distribution in distributions():
    name = distribution.metadata["Name"]
    for file in distribution.files or []:
        if file.name.lower().startswith(("license", "licence", "copying", "notice")):
            source = Path(distribution.locate_file(file))
            if source.is_file():
                relative = Path(
                    *[
                        part
                        for part in file.parts
                        if part not in (".", "..", "/", "\\") and ":" not in part
                    ]
                )
                target = output / name / relative
                target.resolve().relative_to(output.resolve())
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
    inventory.append(f"{name}=={distribution.version}")
(output / "distribution-inventory.txt").write_text(
    "\n".join(sorted(inventory)), encoding="utf-8"
)
