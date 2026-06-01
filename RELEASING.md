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
npm run publish        # → publish.sh: preflight, then npm publish (build+test via prepublishOnly)
```

`npm run publish` (and its alias `npm run release`) run `publish.sh`, which does
the five-step contract: clean-tree/main/auth preflight, then `npm publish` (whose
`prepublishOnly` builds + runs the tests), then a registry verify.

### npm 2FA: use an automation token

This npm account uses **web-based 2FA**, which a non-interactive shell can't
complete (it errors `EOTP`). For any scripted publish, put an **automation
token** in `~/.npmrc` — it bypasses 2FA for that token:

```bash
# npmjs.com → Access Tokens → Generate New Token → Automation
echo "//registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx" >> ~/.npmrc
npm run publish
```

(On a TOTP account you could instead pass `./publish.sh --otp=123456`, but this
account is web-2FA, so the token is the correct path.)

`memlight` is free on npm. After publish, Akemi depends on it as a normal
registry dependency (`"memlight": "^0.1.0"`) instead of the workspace link;
during local dev you can `npm link memlight` against this checkout.

## Verify the tarball before publishing

```bash
npm pack            # inspect the .tgz: it must ship only dist/, README, LICENSE, CHANGELOG
```
