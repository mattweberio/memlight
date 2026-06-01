# Releasing memlight

memlight is developed here (inside the akemi monorepo) but ships as a
standalone public repo + npm package. It has zero monorepo coupling — its only
runtime dependency is `@electric-sql/pglite` — so extraction is a clean copy.

## One-time: extract to its own public repo

Run from a scratch dir (you run these — repo creation + npm publish are yours):

```bash
# 1. Create the public repo
gh repo create mattweberio/memlight --public \
  --description "Embedded vector memory for AI agents. PGlite + pgvector."

# 2. Copy the package contents (NOT the monorepo wrapper)
mkdir memlight && cd memlight
cp -r /var/www/sandbox/akemi/packages/memlight/{src,test,README.md,LICENSE,CHANGELOG.md,RELEASING.md,package.json,tsconfig.json,vitest.config.ts,.gitignore} .

# 3. Init + push
git init && git add -A && git commit -m "memlight 0.1.0"
git branch -M main
git remote add origin https://github.com/mattweberio/memlight.git
git push -u origin main
```

## Publish to npm

```bash
npm ci
npm publish        # prepublishOnly runs build + tests first; access is public
```

`memlight` is free on npm. After publish, Akemi depends on it as a normal
registry dependency (`"memlight": "^0.1.0"`) instead of the workspace link;
during local dev you can `npm link memlight` against this checkout.

## Verify the tarball before publishing

```bash
npm pack            # inspect the .tgz: it must ship only dist/, README, LICENSE, CHANGELOG
```
