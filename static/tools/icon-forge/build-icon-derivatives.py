#!/usr/bin/env python3
"""
Speciedex Icon Forge

Generate derivative PNG icon sizes from the master icons.

Expected location:

    static/tools/icon-forge/build-icon-derivatives.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


DEFAULT_SIZES = (
    512,
    256,
    128,
    64,
    32,
)


def resize_directory(
    source_root: Path,
    output_root: Path,
    sizes: list[int],
) -> int:

    generated = 0

    for source in sorted(source_root.rglob("*.png")):

        relative = source.relative_to(source_root)

        with Image.open(source) as image:

            rgba = image.convert("RGBA")

            for size in sizes:

                destination = (
                    output_root
                    / str(size)
                    / relative
                )

                destination.parent.mkdir(
                    parents=True,
                    exist_ok=True,
                )

                resized = rgba.resize(
                    (
                        size,
                        size,
                    ),
                    Image.Resampling.LANCZOS,
                )

                resized.save(
                    destination,
                    "PNG",
                    optimize=True,
                    compress_level=9,
                )

                generated += 1

    return generated


def parser() -> argparse.ArgumentParser:

    p = argparse.ArgumentParser(
        description=(
            "Generate derivative icon sizes "
            "from Speciedex master icons."
        )
    )

    p.add_argument(
        "--input",
        required=True,
    )

    p.add_argument(
        "--output",
        required=True,
    )

    p.add_argument(
        "--sizes",
        nargs="+",
        type=int,
        default=list(DEFAULT_SIZES),
    )

    return p


def main() -> int:

    args = parser().parse_args()

    source_root = Path(args.input)
    output_root = Path(args.output)

    generated = resize_directory(
        source_root,
        output_root,
        args.sizes,
    )

    print(
        f"generated={generated}"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
