# Security Policy

## Supported Versions

Security fixes target the latest published npm version.

## Reporting a Vulnerability

Do not open a public issue for credential leaks or exploitable vulnerabilities.
Use GitHub's private vulnerability reporting for this repository when
available, or contact the maintainer through the GitHub profile linked from the
repository.

## Secrets and Local Data

memlight does not require API keys by default. It stores caller-provided memory
content on the local machine, under the OS app-data directory unless `dataDir`
is set explicitly.

Do not commit local memory stores, `.npmrc`, npm tokens, model caches, private
fixtures, or exported JSONL backups containing real user data.

