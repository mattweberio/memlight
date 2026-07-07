# Agent Instructions

These instructions apply to automated coding agents working in this repository.

- Treat this as a public npm package. Do not add private infrastructure names,
  tokens, local paths, customer data, or unpublished roadmap claims.
- Install with `npm ci`; validate with `npm run type-check`, `npm test`, and
  `npm run build`.
- Keep package metadata accurate for npm: package name `memlight`, source
  `https://github.com/mattweberio/memlight`, license MIT, Node.js >=22.
- Use placeholder tokens only. Do not write real npm tokens, API keys, exported
  memories, local database contents, or model cache paths.
- Update `README.md`, `CHANGELOG.md`, and `RELEASING.md` when public API,
  defaults, package contents, or release steps change.
- Do not commit generated or local artifacts: `node_modules/`, `dist/` unless
  intentionally building a tracked release artifact, `*.tgz`, `.npmrc`, model
  caches, or local memory stores.

