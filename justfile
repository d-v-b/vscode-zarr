# Development verbs for the Zarr Metadata VS Code extension. Recipes run
# with this directory as the working directory regardless of where `just`
# is invoked.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    npm install

# Bundle the extension to dist/extension.js
build:
    npm run build

# Type-check the extension sources
typecheck:
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

# Regenerate the JSON Schemas from the Python zarr-metadata package.
# `ref` is what `uv run --with` installs: the PyPI package by default, or a
# path to a local zarr-python checkout's packages/zarr-metadata, e.g.
# `just schemas ../zarr-python/packages/zarr-metadata`.
schemas ref="zarr-metadata":
    uv run --with 'pydantic>=2.13' --with '{{ ref }}' --no-project python scripts/generate_schemas.py
