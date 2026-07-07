# Releasing memlight

memlight ships as the public npm package `memlight`.

## Preconditions

- Node.js 22 or newer.
- npm authentication for the `matt.weber.io` npm account or another maintainer
  with publish rights.
- A clean `main` branch.
- The version in `package.json` and the top entry in `CHANGELOG.md` agree.

For non-interactive publishing, use an npm automation token in `~/.npmrc`:

```bash
//registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx
```

Do not commit `.npmrc` or real tokens.

## Dry Run

```bash
npm ci
npm run type-check
npm test
npm pack --dry-run
npm run release -- --dry-run
```

The package tarball should contain only built `dist/` files plus package
metadata and docs allowed by `package.json#files`.

## Publish

1. Update `package.json`.
2. Update `CHANGELOG.md`.
3. Commit the release changes.
4. Run:

```bash
npm run release
```

The `release` script calls `publish.sh`, which checks for a clean tree and npm
authentication before running `npm publish`. The `prepublishOnly` script builds
and tests immediately before upload.

Do not add an npm script named `publish`; npm treats that as a lifecycle hook
and runs it during `npm publish`.

## Verify

```bash
npm view memlight version
npm view memlight dist.tarball
npm pack --dry-run
```

The latest registry version should match `package.json`.
