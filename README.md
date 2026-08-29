# Zarr Metadata

Validation, hover documentation, and completions for
[Zarr](https://zarr.dev) metadata documents.

## Features

- **`zarr.json`** (Zarr v3, array and group), **`.zarray`**, **`.zgroup`**,
  **`.zattrs`** (Zarr v2), and **`.zmetadata`** (v2 consolidated) are
  recognized automatically — the dotfiles are associated with JSON so they
  get syntax highlighting and formatting.
- **Schema validation** via VS Code's built-in JSON language service:
  required keys, literal values, enum members, and per-field hover
  documentation with links to the Zarr specs. Schemas are generated from the
  Python [`zarr-metadata`](https://pypi.org/project/zarr-metadata/)
  package's types.
- **Structural diagnostics** beyond what JSON Schema can express, from a
  TypeScript port of the `zarr-metadata` validators:
  - one `dimension_names` entry per dimension of `shape`
  - `chunks` and `shape` dimensionality agreement (v2)
  - non-empty codec pipelines, `must_understand` rules at each extension
    point, closed metadata-field envelopes
  - deep validation of inline `consolidated_metadata` entries

Every diagnostic is placed on the exact offending value (source: `zarr`).

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
