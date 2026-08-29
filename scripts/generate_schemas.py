"""Generate the extension's docs-only JSON Schemas from the Python zarr-metadata package.

The Python package's `_pydantic_schema` module defines schema-input TypedDicts
whose whole purpose is producing accurate JSON Schemas. This script emits one
schema per metadata file kind into schemas/, adding titles and per-field
descriptions — and then STRIPS every assertion keyword, because the schemas
exist only to power completions and hover documentation. Validation is the
diagnostics layer's job (src/extension.ts + the zarr-metadata validators),
which checks a strict superset of what these schemas could assert; leaving
assertions in would double-report every problem from a second source with
coarser ranges and different wording (`const`/`enum` become `examples` so
value completions survive).

Usage (mirrors the zarr-metadata-ts repo's check_conformance.py):

    uv run --with 'pydantic>=2.13' --with /path/to/zarr-python/packages/zarr-metadata \
        python scripts/generate_schemas.py

Regenerate whenever zarr-metadata changes; the output is checked in.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import zarr_metadata._pydantic_schema as ps
from pydantic import TypeAdapter

OUT_DIR = Path(__file__).resolve().parent.parent / "schemas"

SPEC_V3 = "https://zarr-specs.readthedocs.io/en/latest/v3/core/index.html"
SPEC_V2 = "https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html"

# Hover documentation, keyed by $defs entry name then property name.
FIELD_DOCS: dict[str, dict[str, str]] = {
    "ZarrV3ArrayMetadataJSON": {
        "zarr_format": "The Zarr format version. Always the integer 3.",
        "node_type": 'The node kind. Always "array" for array metadata.',
        "shape": "The dimensions of the array: one non-negative integer per axis.",
        "data_type": (
            'The data type of the array\'s elements, e.g. "float64" or a '
            '{"name", "configuration"} object for parameterized types.'
        ),
        "chunk_grid": (
            'How the array is divided into chunks. The core spec defines the "regular" '
            'grid, configured with a "chunk_shape".'
        ),
        "chunk_key_encoding": (
            'How chunk grid indices map to store keys. The core spec defines "default" '
            '(separator "/") and "v2" (separator ".").'
        ),
        "fill_value": (
            "The value used for unwritten regions of the array. Its permitted JSON shape "
            'depends on data_type (e.g. "NaN" or a hex string for floats).'
        ),
        "codecs": (
            "The codec pipeline applied to each chunk, in order: zero or more "
            "array→array codecs, exactly one array→bytes codec, then zero or more "
            "bytes→bytes codecs."
        ),
        "attributes": "Arbitrary user metadata for this array.",
        "storage_transformers": (
            "Storage transformers applied between the codec pipeline and the store. "
            "Rarely used; an empty list is equivalent to absence."
        ),
        "dimension_names": (
            "An optional name (or null) for each dimension. Must have exactly one entry "
            "per dimension of shape."
        ),
    },
    "ZarrV3GroupMetadataJSON": {
        "zarr_format": "The Zarr format version. Always the integer 3.",
        "node_type": 'The node kind. Always "group" for group metadata.',
        "attributes": "Arbitrary user metadata for this group.",
        "consolidated_metadata": (
            "Inline consolidated metadata: a snapshot of every child document, embedded "
            "by the reference implementation. Not part of the v3 core spec."
        ),
    },
    "ZarrV2ArrayMetadataJSON": {
        "zarr_format": "The Zarr format version. Always the integer 2.",
        "shape": "The dimensions of the array: one non-negative integer per axis.",
        "chunks": (
            "The chunk dimensions: one non-negative integer per axis, with the same "
            "number of dimensions as shape."
        ),
        "dtype": (
            'The numpy-style data type, e.g. "<f8" (little-endian float64), or a list '
            "of field records for structured dtypes."
        ),
        "compressor": (
            "The primary compressor: a numcodecs configuration object with a string "
            '"id", or null for no compression.'
        ),
        "fill_value": "The value used for unwritten chunks.",
        "order": ('The in-chunk memory layout: "C" (row-major) or "F" (column-major).'),
        "filters": (
            "A list of numcodecs filter configurations applied before the compressor, "
            "or null for none. An empty list is not permitted."
        ),
        "dimension_separator": (
            'The chunk-key separator: "." (default, flat keys like 0.0) or "/" '
            "(nested directories)."
        ),
        "attributes": (
            "User attributes. On disk these live in the sibling .zattrs file, NOT in "
            ".zarray; this key is tolerated here for merged representations."
        ),
    },
    "ZarrV2GroupMetadataJSON": {
        "zarr_format": "The Zarr format version. Always the integer 2.",
        "attributes": (
            "User attributes. On disk these live in the sibling .zattrs file, NOT in "
            ".zgroup; this key is tolerated here for merged representations."
        ),
    },
    "ZarrV2ConsolidatedMetadataJSON": {
        "zarr_consolidated_format": "The consolidated-metadata format version. Always 1.",
        "metadata": (
            'Flat map from store path (e.g. "a/b/.zarray") to the JSON contents of '
            "the file at that path."
        ),
    },
}


def attach_docs(schema: dict[str, Any]) -> dict[str, Any]:
    """Attach FIELD_DOCS descriptions to matching $defs entries (and the root)."""
    targets: dict[str, dict[str, Any]] = dict(schema.get("$defs", {}))
    # A non-union root schema holds its properties at the top level.
    if "properties" in schema and "title" in schema:
        targets[schema["title"]] = schema
    for name, docs in FIELD_DOCS.items():
        target = targets.get(name)
        if target is None:
            continue
        for prop, description in docs.items():
            prop_schema = target.get("properties", {}).get(prop)
            if prop_schema is not None and "description" not in prop_schema:
                prop_schema["description"] = description
    return schema


# JSON Schema keywords that ASSERT (produce validation errors). Everything
# else — properties, items, descriptions, refs, examples, defaultSnippets —
# only informs navigation, completion, and hover.
ASSERTION_KEYWORDS = frozenset({
    "required",
    "type",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minProperties",
    "maxProperties",
    "pattern",
    "multipleOf",
    "uniqueItems",
    "not",
})


def deassert(node: Any) -> Any:
    """Recursively strip assertion keywords; fold const/enum into examples."""
    if isinstance(node, list):
        return [deassert(item) for item in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key in ASSERTION_KEYWORDS:
            continue
        if key == "additionalProperties" and value is False:
            continue
        if key in ("const", "enum"):
            examples = [value] if key == "const" else list(value)
            merged = out.get("examples", [])
            out["examples"] = merged + [ex for ex in examples if ex not in merged]
            continue
        out[key] = deassert(value)
    return out


def build(adapter_type: Any, title: str, description: str) -> dict[str, Any]:
    # attach_docs matches on pydantic's own class-name titles, so it runs
    # before the friendly title/description override them.
    schema = deassert(attach_docs(TypeAdapter(adapter_type).json_schema()))
    rest = {k: v for k, v in schema.items() if k not in ("title", "description")}
    return {"title": title, "description": description, **rest}


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "zarr3.schema.json": build(
            ps.ZarrV3ArrayMetadataJSON | ps.ZarrV3GroupMetadataJSON,
            "Zarr v3 metadata (zarr.json)",
            f"A Zarr v3 array or group metadata document. See {SPEC_V3}",
        ),
        "zarr2-array.schema.json": build(
            ps.ZarrV2ArrayMetadataJSON,
            "Zarr v2 array metadata (.zarray)",
            f"A Zarr v2 array metadata document. See {SPEC_V2}",
        ),
        "zarr2-group.schema.json": build(
            ps.ZarrV2GroupMetadataJSON,
            "Zarr v2 group metadata (.zgroup)",
            f"A Zarr v2 group metadata document. See {SPEC_V2}",
        ),
        "zarr2-attrs.schema.json": {
            "title": "Zarr v2 user attributes (.zattrs)",
            "description": (
                f"Arbitrary user attributes for the sibling v2 array or group. See {SPEC_V2}"
            ),
        },
        "zarr2-consolidated.schema.json": build(
            ps.ZarrV2ConsolidatedMetadataJSON,
            "Zarr v2 consolidated metadata (.zmetadata)",
            "The reference implementation's consolidated-metadata convention "
            "(not a spec artifact).",
        ),
    }
    for name, schema in outputs.items():
        path = OUT_DIR / name
        path.write_text(json.dumps(schema, indent=2) + "\n")
        print(f"wrote {path.relative_to(OUT_DIR.parent)}")


if __name__ == "__main__":
    main()
