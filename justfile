# Development verbs for the Zarr Metadata VS Code extension. Recipes run
# with this directory as the working directory regardless of where `just`
# is invoked.
#
# The extension depends on the zarr-metadata library from a sibling
# checkout (file:../zarr-metadata-ts) until it is published to npm; run
# `just build` there first after changing library code — the dependency
# resolves against its dist/.

# List available recipes
default:
    @just --list

# Install dependencies (also links the sibling zarr-metadata checkout)
install:
    npm install

# Bundle the extension to dist/extension.js
build:
    npm run build

# Type-check the extension sources
typecheck:
    npm run typecheck

# Run everything CI runs for this package
check: typecheck build

# Build a .vsix for manual installation or Marketplace upload
package: build
    npx --yes @vscode/vsce package --no-dependencies

# Regenerate the JSON Schemas from the Python zarr-metadata package.
# `ref` is what `uv run --with` installs: the PyPI package by default, or a
# path to a local zarr-python checkout's packages/zarr-metadata, e.g.
# `just schemas ../zarr-python/packages/zarr-metadata`.
schemas ref="zarr-metadata":
    uv run --with 'pydantic>=2.13' --with '{{ ref }}' --no-project python scripts/generate_schemas.py
