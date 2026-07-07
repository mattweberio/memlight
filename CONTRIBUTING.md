# Contributing

memlight is a small TypeScript package. Keep the public API stable, tested, and
well documented.

## Setup

```bash
npm ci
npm run type-check
npm test
npm run build
```

## Development Rules

- Keep tests under `test/` close to the behavior they protect.
- Update `README.md` for user-facing API, default behavior, storage, or install
  changes.
- Update `CHANGELOG.md` for release-worthy changes.
- Do not commit `node_modules/`, `.npmrc`, model caches, local databases,
  package tarballs, or credentials.
- Keep `npm pack --dry-run` small and intentional.

## Release

See `RELEASING.md`. npm versions are immutable once published.

