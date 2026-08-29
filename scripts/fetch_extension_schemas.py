"""Build schemas/extension-registry.json: per-extension configuration schemas.

Two sources, merged into one bundled registry the diagnostics engine loads:

- the zarr-extensions registry (github.com/zarr-developers/zarr-extensions),
  vendored at the pinned commit below — the ecosystem's registry of record
  for v3 extension schemas;
- schemas/extensions-core/, hand-written in the same whole-object format for
  the core-spec extension points zarr-extensions does not carry (blosc,
  gzip, crc32c, sharding_indexed, the regular chunk grid, and the chunk key
  encodings live in zarr-specs proper).

Each schema describes the full `{name, configuration}` object; the
diagnostics engine deliberately validates only the `configuration` subtree
(the name is the lookup key, and top-level `additionalProperties: false`
in registry schemas would false-positive on the spec-legal
`must_understand` member) plus whether a configuration is required at all.

Usage: python scripts/fetch_extension_schemas.py
(network access to github.com required; output is checked in).
"""

from __future__ import annotations

import io
import json
import tarfile
import urllib.request
from pathlib import Path

# Bump deliberately; the registry contents become validation behavior.
ZARR_EXTENSIONS_COMMIT = "4da7b37a84f76e660902f6d3de3eaef0e0febae6"

ROOT = Path(__file__).resolve().parent.parent
CORE_DIR = ROOT / "schemas" / "extensions-core"
OUT_PATH = ROOT / "schemas" / "extension-registry.json"

# zarr-extensions directory -> the metadata extension point it configures.
POINTS = {
    "codecs": "codecs",
    "data-types": "data_type",
    "chunk-grids": "chunk_grid",
    "chunk-key-encodings": "chunk_key_encoding",
}


def fetch_vendored() -> dict[str, dict[str, object]]:
    url = (
        "https://github.com/zarr-developers/zarr-extensions/archive/"
        f"{ZARR_EXTENSIONS_COMMIT}.tar.gz"
    )
    with urllib.request.urlopen(url) as response:
        archive = tarfile.open(fileobj=io.BytesIO(response.read()), mode="r:gz")
    registry: dict[str, dict[str, object]] = {point: {} for point in POINTS.values()}
    for member in archive.getmembers():
        parts = Path(member.name).parts  # (repo-<sha>, <dir>, <name>, schema.json)
        if len(parts) != 4 or parts[3] != "schema.json" or parts[1] not in POINTS:
            continue
        extracted = archive.extractfile(member)
        assert extracted is not None, member.name
        registry[POINTS[parts[1]]][parts[2]] = json.loads(extracted.read())
    return registry


def merge_core(registry: dict[str, dict[str, object]]) -> None:
    for path in sorted(CORE_DIR.glob("*/*.schema.json")):
        point = path.parent.name
        name = path.name.removesuffix(".schema.json")
        assert point in registry, f"unknown extension point directory {point}"
        assert name not in registry[point], (
            f"{point}/{name} is now in zarr-extensions; drop the core copy"
        )
        registry[point][name] = json.loads(path.read_text())


def main() -> None:
    registry = fetch_vendored()
    merge_core(registry)
    out = {
        "source": {
            "repository": "zarr-developers/zarr-extensions",
            "commit": ZARR_EXTENSIONS_COMMIT,
        },
        **{point: dict(sorted(schemas.items())) for point, schemas in registry.items()},
    }
    OUT_PATH.write_text(json.dumps(out, indent=2) + "\n")
    counts = ", ".join(f"{point}: {len(schemas)}" for point, schemas in registry.items())
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({counts})")


if __name__ == "__main__":
    main()
