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
  against the [zarr-extensions](https://github.com/zarr-developers/zarr-extensions)
  registry's schemas (vendored at a pinned commit, plus core-spec schemas
  the registry does not carry), including codec pipelines nested inside
  `sharding_indexed`. Unknown extension names are left alone — the name
  space is open.

Every diagnostic comes from the same engine, covers the offending
property, and carries a code linking to the relevant spec section.

## Notes

- `.zarray`/`.zgroup` validation accepts a merged `attributes` key for
  tooling interoperability; per the v2 spec, on-disk attributes belong in
  the sibling `.zattrs` file.
- Validation is structural, not domain-level: dtype strings and codec
  configurations are checked for shape, not interpreted.

## Development

The extension depends on the TypeScript
[`zarr-metadata`](https://github.com/d-v-b/zarr-metadata-ts) library
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
