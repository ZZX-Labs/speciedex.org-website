#!/usr/bin/env python3
"""
Speciedex Icon Forge

Verify generated icon assets, manifest integrity, PNG validity,
identity uniqueness, and duplicate raster output.

Expected location:

    static/tools/icon-forge/verify-icons.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

from PIL import Image


def load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"manifest does not exist: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(payload, dict):
        raise ValueError("manifest root must be a JSON object")

    icons = payload.get("icons")

    if not isinstance(icons, list):
        raise ValueError("manifest must contain an 'icons' array")

    return payload


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as handle:
        while True:
            block = handle.read(1024 * 1024)

            if not block:
                break

            digest.update(block)

    return digest.hexdigest()


def verify_png(path: Path) -> tuple[int, int, str]:
    with Image.open(path) as image:
        image.verify()

    with Image.open(path) as image:
        width, height = image.size
        mode = image.mode

    return width, height, mode


def verify_manifest(
    manifest: dict[str, Any],
    image_root: Path,
) -> int:
    errors = 0

    seen_identities: dict[str, str] = {}
    seen_files: dict[str, str] = {}
    seen_png_hashes: dict[str, str] = {}

    icons = manifest.get("icons", [])

    for index, entry in enumerate(icons, start=1):
        if not isinstance(entry, dict):
            print(
                f"[{index}] manifest entry must be an object",
                file=sys.stderr,
            )
            errors += 1
            continue

        scientific_name = str(
            entry.get("scientific_name", "")
        ).strip()

        identity = str(
            entry
            .get("parameters", {})
            .get("identity_sha256", "")
        ).strip()

        file_value = str(
            entry.get("file", "")
        ).strip()

        expected_size = entry.get("size")

        if not scientific_name:
            print(
                f"[{index}] missing scientific_name",
                file=sys.stderr,
            )
            errors += 1

        if not identity:
            print(
                f"[{index}] missing parameters.identity_sha256",
                file=sys.stderr,
            )
            errors += 1
        else:
            previous_name = seen_identities.get(identity)

            if previous_name is not None:
                print(
                    f"[{index}] duplicate identity_sha256: "
                    f"{identity} ({previous_name} / {scientific_name})",
                    file=sys.stderr,
                )
                errors += 1
            else:
                seen_identities[identity] = scientific_name

        if not file_value:
            print(
                f"[{index}] missing file path",
                file=sys.stderr,
            )
            errors += 1
            continue

        path = Path(file_value)

        if not path.is_absolute() and not path.exists():
            candidate = image_root / path

            if candidate.exists():
                path = candidate

        normalized_path = path.as_posix()

        previous_identity = seen_files.get(normalized_path)

        if previous_identity is not None:
            print(
                f"[{index}] duplicate manifest file path: "
                f"{normalized_path}",
                file=sys.stderr,
            )
            errors += 1
        else:
            seen_files[normalized_path] = identity

        if not path.exists():
            print(
                f"[{index}] missing PNG: {path}",
                file=sys.stderr,
            )
            errors += 1
            continue

        if not path.is_file():
            print(
                f"[{index}] icon path is not a file: {path}",
                file=sys.stderr,
            )
            errors += 1
            continue

        if path.suffix.lower() != ".png":
            print(
                f"[{index}] icon is not a PNG: {path}",
                file=sys.stderr,
            )
            errors += 1
            continue

        try:
            width, height, mode = verify_png(path)
        except Exception as exc:
            print(
                f"[{index}] invalid PNG {path}: {exc}",
                file=sys.stderr,
            )
            errors += 1
            continue

        if width != height:
            print(
                f"[{index}] icon is not square: "
                f"{path} ({width}x{height})",
                file=sys.stderr,
            )
            errors += 1

        if isinstance(expected_size, int):
            if width != expected_size or height != expected_size:
                print(
                    f"[{index}] unexpected icon dimensions: "
                    f"{path} ({width}x{height}, expected "
                    f"{expected_size}x{expected_size})",
                    file=sys.stderr,
                )
                errors += 1

        if mode not in {"RGBA", "LA", "P"}:
            print(
                f"[{index}] PNG may lack transparency support: "
                f"{path} (mode={mode})",
                file=sys.stderr,
            )
            errors += 1

        try:
            png_hash = sha256_file(path)
        except Exception as exc:
            print(
                f"[{index}] unable to hash {path}: {exc}",
                file=sys.stderr,
            )
            errors += 1
            continue

        previous = seen_png_hashes.get(png_hash)

        if previous is not None and previous != identity:
            print(
                f"[{index}] duplicate PNG raster bytes: "
                f"{path} matches identity {previous}",
                file=sys.stderr,
            )
            errors += 1
        else:
            seen_png_hashes[png_hash] = identity

    print(
        f"manifest_icons={len(icons)} "
        f"unique_identities={len(seen_identities)} "
        f"unique_files={len(seen_files)} "
        f"unique_pngs={len(seen_png_hashes)} "
        f"errors={errors}"
    )

    return errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Verify Speciedex Icon Forge manifest and PNG assets."
        )
    )

    parser.add_argument(
        "--manifest",
        required=True,
        help="Path to icon-manifest.json.",
    )

    parser.add_argument(
        "--image-root",
        required=True,
        help=(
            "Root directory containing generated icon assets. "
            "Used to resolve relative paths when necessary."
        ),
    )

    return parser


def main() -> int:
    args = build_parser().parse_args()

    manifest_path = Path(args.manifest)
    image_root = Path(args.image_root)

    try:
        manifest = load_manifest(manifest_path)
        errors = verify_manifest(
            manifest=manifest,
            image_root=image_root,
        )
    except Exception as exc:
        print(
            f"verification failed: {exc}",
            file=sys.stderr,
        )
        return 1

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
