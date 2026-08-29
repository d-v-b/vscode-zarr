# Releasing

Extension releases are tag-triggered: bump the version, push the tag, and
the Release workflow packages the `.vsix`, publishes it to the VS Code
Marketplace and Open VSX (each only if its secret is configured), and
attaches it to a GitHub release.

## Cutting a release

```bash
npm version minor        # or patch/major; commits and tags vX.Y.Z
git push --follow-tags
```

Marketplace note: the Marketplace does not support semver prerelease
suffixes; pre-release channels use `vsce publish --pre-release` and, by
convention, odd minor versions.

## One-time setup (not yet done)

1. **Marketplace**: decide the publisher — `package.json` currently says
   `d-v-b`; if the extension should live under a zarr-developers
   publisher, create it at marketplace.visualstudio.com/manage and update
   the `publisher` field first. Then create an Azure DevOps PAT with the
   **Marketplace → Manage** scope and add it as the `VSCE_PAT` repository
   secret.
2. **Open VSX** (used by Cursor/VSCodium/code-server): create the
   namespace matching the publisher at open-vsx.org, generate an access
   token, add it as the `OVSX_PAT` repository secret.
3. Without the secrets, the corresponding publish steps are skipped —
   tagging still produces a GitHub release with an installable `.vsix`.

The `zarr-metadata` dependency resolves from a sibling checkout of
`d-v-b/zarr-metadata-ts` (the workflows reproduce that layout);
once the library is published to npm, switch the dependency to a semver
range and simplify both workflows.
