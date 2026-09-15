# Zarr Metadata

Validation, hover documentation, and completions for
[Zarr](https://zarr.dev) metadata documents.

## Features

- **`zarr.json`** (Zarr v3, array and group), **`.zarray`**, **`.zgroup`**,
  **`.zattrs`** (Zarr v2), and **`.zmetadata`** (v2 consolidated) are
  recognized automatically — the dotfiles are associated with JSON so they
  get syntax highlighting and formatting.
- **Completions and hover documentation** via VS Code's built-in JSON
  language service, driven by docs-only schemas generated from the Python
  [`zarr-metadata`](https://pypi.org/project/zarr-metadata/) package's
  types (assertion keywords are stripped at generation time, so the schema
  layer never produces diagnostics of its own).
- **One uniform source of diagnostics** — a TypeScript port of the
  `zarr-metadata` validators covering everything the spec requires,
  including what JSON Schema could never express:
  - one `dimension_names` entry per dimension of `shape`
  - `chunks` and `shape` dimensionality agreement (v2)
  - non-empty codec pipelines, `must_understand` rules at each extension
    point, closed metadata-field envelopes
  - deep validation of inline `consolidated_metadata` entries
  - a warning for unrecognized v3 extension fields not waived with
    `"must_understand": false` — the spec obligates readers to refuse
    nodes carrying such fields
- **Extension-point configuration validation**: recognized codec, chunk
  grid, chunk key encoding, and data type configurations are validated
  against schemas, including codec pipelines nested inside
  `sharding_indexed`. Unknown extension names within edit distance of a
  registered one get a "did you mean" warning; names far from everything
  registered are respected as intentionally novel — the extension name
  space is open.
- **The recognized-name set is a setting** (`zarr.extensionSchemas`):
  by default only the Zarr v3 core specification's extension points are
  recognized; opting in to `"zarr-extensions"` additionally recognizes
  everything in the
  [zarr-extensions](https://github.com/zarr-developers/zarr-extensions)
  registry (vendored at a pinned commit). A name defined in a disabled
  registry gets a warning pointing at the setting instead of a spurious
  did-you-mean.

Every diagnostic comes from the same engine, covers the offending
property, and carries a code linking to the relevant spec section. Quick
fixes repair what the diagnostics find: one-click rename for near-miss
extension names, and "mark as ignorable" to insert the
`"must_understand": false` waiver on an extension field.

## Notes

- Per the v2 spec, attributes live only in the sibling `.zattrs` file. An
  `attributes` key — like any key the spec doesn't define — is a warning in
  a `.zarray` file ("SHOULD NOT be present") and an error in a `.zgroup`
  file ("MUST NOT be present"), including such entries of `.zmetadata`.
- Zarr v2 validation is structural: `dtype` strings, `fill_value`, and
  `compressor`/`filters` configurations are checked for shape, not
  interpreted. (Zarr v3 goes further, as described above: fill values are
  checked against the data type, and recognized codec configurations
  against their schemas.)

## Development

The extension depends on the TypeScript
[`zarr-metadata`](https://github.com/d-v-b/zarr-metadata.js) library
(from npm).

Development verbs live in the [justfile](justfile) (needs
[`just`](https://github.com/casey/just), plus `uv` for the schemas
recipe); `just` with no arguments lists them:

```bash
just install       # npm install
just build         # esbuild → dist/extension.js
just typecheck
just check         # everything CI runs
just package       # build a .vsix
just schemas       # regenerate the JSON Schemas from the Python package
```

Press **F5** in VS Code to launch the extension against the deliberately
valid-and-broken documents in `example/`. Each recipe wraps a plain
npm/npx/uv command, so `just` itself is optional.

Releases are tag-driven; see [RELEASING.md](RELEASING.md).
