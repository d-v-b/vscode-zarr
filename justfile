# Development verbs for the Zarr Metadata VS Code extension. Recipes run
# with this directory as the working directory regardless of where `just`
# is invoked.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    npm install

# Fetch dependencies when node_modules is missing (fresh clone / new machine)
_deps:
    @[ -d node_modules ] || npm install

# Bundle the extension to dist/extension.js
build: _deps
    npm run build

# Type-check the extension sources
typecheck: _deps
    npm run typecheck

# Activation smoke test: load the built bundle with a stubbed vscode
# module and run the example fixture through the diagnostics pipeline
smoke: build
    node scripts/smoke.cjs

# Run everything CI runs for this package
check: typecheck smoke

# Build a .vsix for manual installation or Marketplace upload
package: build
    npx --yes @vscode/vsce package --no-dependencies

# Rebuild schemas/extension-registry.json: the zarr-extensions registry
# vendored at the commit pinned in the script, merged with the core-spec
# schemas in schemas/extensions-core/
registry-schemas:
    python3 scripts/fetch_extension_schemas.py

# Regenerate the JSON Schemas from the Python zarr-metadata package.
# `ref` is what `uv run --with` installs: the PyPI package by default, or a
# path to a local zarr-python checkout's packages/zarr-metadata, e.g.
# `just schemas ../zarr-python/packages/zarr-metadata`.
schemas ref="zarr-metadata":
    uv run --with 'pydantic>=2.13' --with '{{ ref }}' --no-project python scripts/generate_schemas.py
