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

# Which pipeline stage each known codec occupies. Sources: the codec's
# zarr-specs page for the core codecs, its zarr-extensions README otherwise
# ("Defines an `array -> array` codec ..."). The pipeline rule (array->array*,
# exactly one array->bytes, bytes->bytes*) is checked by the diagnostics
# engine; codecs absent from this map get no pipeline checks at all.
CODEC_STAGES = {
    "array_to_array": ["transpose", "bitround", "reshape", "scale_offset", "cast_value"],
    "array_to_bytes": [
        "bytes",
        "sharding_indexed",
        "zfp",
        "packbits",
        "n5_default",
        "vlen-utf8",
        "vlen-bytes",
    ],
    "bytes_to_bytes": ["blosc", "gzip", "zstd", "crc32c"],
}

# Names defined by the CORE v3 spec (zarr-specs), regardless of where their
# schema happens to be maintained — several core codecs' schemas are
# vendored from zarr-extensions. Everything else is source "zarr-extensions"
# and only recognized when the user opts in via the zarr.extensionSchemas
# setting. Core data types are enumerated in schemas/extensions-core; the
# r<N> raw-bits pattern is recognized in code.
CORE_SPEC_NAMES = {
    "codecs": {"bytes", "transpose", "zstd", "blosc", "gzip", "crc32c", "sharding_indexed"},
    "chunk_grid": {"regular"},
    "chunk_key_encoding": {"default", "v2"},
}

# zarr-specs pages for core codecs whose schemas are vendored from
# zarr-extensions (their documentation link should be the spec, not the
# registry directory).
CORE_SPEC_DOCS = {
    ("codecs", "bytes"): "https://zarr-specs.readthedocs.io/en/latest/v3/codecs/bytes/index.html",
    ("codecs", "transpose"): "https://zarr-specs.readthedocs.io/en/latest/v3/codecs/transpose/index.html",
    ("codecs", "zstd"): "https://zarr-specs.readthedocs.io/en/latest/v3/codecs/zstd/index.html",
}

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
        schema = json.loads(extracted.read())
        point, name = POINTS[parts[1]], parts[2]
        core = name in CORE_SPEC_NAMES.get(point, set())
        schema["source"] = "core-spec" if core else "zarr-extensions"
        schema["documentation"] = CORE_SPEC_DOCS.get(
            (point, name),
            f"https://github.com/zarr-developers/zarr-extensions/tree/main/{parts[1]}/{name}",
        )
        registry[point][name] = schema
    return registry


def merge_core(registry: dict[str, dict[str, object]]) -> None:
    for path in sorted(CORE_DIR.glob("*/*.schema.json")):
        point = path.parent.name
        name = path.name.removesuffix(".schema.json")
        assert point in registry, f"unknown extension point directory {point}"
        assert name not in registry[point], (
            f"{point}/{name} is now in zarr-extensions; drop the core copy"
        )
        schema = json.loads(path.read_text())
        schema["source"] = "core-spec"
        # Core schemas carry their zarr-specs page as the description.
        if isinstance(schema.get("description"), str) and schema["description"].startswith("http"):
            schema["documentation"] = schema["description"]
        registry[point][name] = schema


def stamp_stages(registry: dict[str, dict[str, object]]) -> None:
    for stage, names in CODEC_STAGES.items():
        for name in names:
            schema = registry["codecs"].get(name)
            assert isinstance(schema, dict), f"no schema for staged codec {name}"
            schema["pipelineStage"] = stage


def main() -> None:
    registry = fetch_vendored()
    merge_core(registry)
    stamp_stages(registry)
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
