#!/usr/bin/env python3
"""Validate and publish the committed Speciedex taxonomy-class PNG sprite set.

The class sprites are authored assets.  They are intentionally not redrawn on
every workflow run: doing so would replace the approved handheld pixel artwork
with a synthetic fallback.  This tool verifies that every required transparent
PNG exists and regenerates only the manifest.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from PIL import Image

OUT = Path("static/images/taxonomy-classes")
CLASSES = (
    "plant", "fungi", "bird", "fish", "mammal", "reptile", "amphibian",
    "crustacean", "insect", "arachnid", "mollusk", "worm", "echinoderm",
    "cnidarian", "sponge", "algae", "protist", "bacteria", "archaea",
    "virus", "pollen", "coral", "plankton", "fossil", "other",
)
LABELS = {name: name.replace("-", " ").title() for name in CLASSES}
LABELS.update({"fungi": "Fungi", "fossil": "Fossil / Extinct"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=OUT)
    args = parser.parse_args(argv)
    root = args.output
    missing: list[str] = []
    invalid: list[str] = []
    icons: list[dict[str, object]] = []

    for name in CLASSES:
        path = root / f"{name}.png"
        if not path.is_file():
            missing.append(path.as_posix())
            continue
        try:
            with Image.open(path) as image:
                image.load()
                if image.format != "PNG" or image.mode not in {"RGBA", "LA", "P"}:
                    invalid.append(path.as_posix())
                    continue
                alpha = image.convert("RGBA").getchannel("A")
                lo, hi = alpha.getextrema()
                if lo != 0 or hi != 255:
                    invalid.append(path.as_posix())
                    continue
                icons.append({
                    "id": name,
                    "label": LABELS[name],
                    "path": f"/static/images/taxonomy-classes/{name}.png",
                    "width": image.width,
                    "height": image.height,
                })
        except Exception:
            invalid.append(path.as_posix())

    if missing or invalid:
        raise SystemExit(
            "taxonomy class icon validation failed\n"
            + "\n".join([*(f"missing: {p}" for p in missing), *(f"invalid: {p}" for p in invalid)])
        )

    manifest = {
        "schema_version": 2,
        "kind": "speciedex-taxonomy-class-icons",
        "format": "png",
        "transparent_background": True,
        "pixel_style": "retro handheld creature sprite",
        "count": len(icons),
        "icons": icons,
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Validated {len(icons)} committed taxonomy class PNG icons in {root}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
