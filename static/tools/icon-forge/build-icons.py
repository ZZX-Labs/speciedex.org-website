#!/usr/bin/env python3
"""
Speciedex Icon Forge
Build deterministic master icons from normalized taxonomy.

Expected location:

    static/tools/icon-forge/build-icons.py
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def load_icon_forge(path: Path):
    spec = importlib.util.spec_from_file_location(
        "speciedex_icon_forge",
        path,
    )

    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    return module


def load_previous_manifest(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}

    payload = json.loads(
        path.read_text(encoding="utf-8")
    )

    previous: dict[str, dict] = {}

    for icon in payload.get("icons", []):

        identity = (
            icon
            .get("parameters", {})
            .get("identity_sha256")
        )

        if identity:
            previous[identity] = icon

    return previous


def write_manifest(
    forge,
    manifest_path: Path,
    icons: list[dict],
    generated: int,
    reused: int,
    failed: int,
) -> None:

    manifest_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    manifest = {
        "generator": "Speciedex Icon Forge",
        "generator_version": forge.GENERATOR_VERSION,
        "count": len(icons),
        "generated": generated,
        "reused": reused,
        "failed": failed,
        "icons": icons,
    }

    manifest_path.write_text(
        json.dumps(
            manifest,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def build(
    forge,
    input_file: Path,
    output_root: Path,
    manifest_path: Path,
    size: int,
    incremental: bool,
) -> int:

    previous = {}

    if incremental:
        previous = load_previous_manifest(
            manifest_path
        )

    icons: list[dict] = []

    generated = 0
    reused = 0
    failed = 0

    with input_file.open(
        "r",
        encoding="utf-8",
    ) as handle:

        for line_number, line in enumerate(
            handle,
            start=1,
        ):

            if not line.strip():
                continue

            try:

                record = forge.taxon_from_mapping(
                    json.loads(line)
                )

                parameters = forge.build_parameters(
                    record
                )

                identity = (
                    parameters.identity_sha256
                )

                if (
                    incremental
                    and identity in previous
                ):

                    previous_entry = previous[
                        identity
                    ]

                    if Path(
                        previous_entry["file"]
                    ).exists():

                        icons.append(
                            previous_entry
                        )

                        reused += 1
                        continue

                rank_directory = (
                    output_root
                    / record.rank
                )

                output_path = (
                    rank_directory
                    / forge.unique_output_name(
                        record,
                        parameters,
                    )
                )

                image, parameters = (
                    forge.draw_taxon_icon(
                        record,
                        size,
                        True,
                    )
                )

                forge.save_png(
                    image,
                    output_path,
                    True,
                )

                icons.append(
                    forge.record_manifest_entry(
                        record,
                        parameters,
                        output_path,
                        size,
                    )
                )

                generated += 1

            except Exception as exc:

                failed += 1

                print(
                    f"[{line_number}] ERROR: {exc}",
                    file=sys.stderr,
                )

    write_manifest(
        forge,
        manifest_path,
        icons,
        generated,
        reused,
        failed,
    )

    print(
        f"generated={generated} "
        f"reused={reused} "
        f"failed={failed}"
    )

    return 1 if failed else 0


def parser() -> argparse.ArgumentParser:

    p = argparse.ArgumentParser(
        description="Generate Speciedex taxonomic icons."
    )

    p.add_argument(
        "--input",
        required=True,
    )

    p.add_argument(
        "--forge",
        required=True,
    )

    p.add_argument(
        "--output",
        required=True,
    )

    p.add_argument(
        "--manifest",
        required=True,
    )

    p.add_argument(
        "--size",
        type=int,
        default=1024,
    )

    p.add_argument(
        "--incremental",
        action="store_true",
    )

    return p


def main() -> int:

    args = parser().parse_args()

    forge = load_icon_forge(
        Path(args.forge)
    )

    return build(
        forge=forge,
        input_file=Path(args.input),
        output_root=Path(args.output),
        manifest_path=Path(args.manifest),
        size=args.size,
        incremental=args.incremental,
    )


if __name__ == "__main__":
    raise SystemExit(main())
