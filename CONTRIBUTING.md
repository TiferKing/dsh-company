# Contributing to dsh-company

Thanks for your interest! This plugin runs inside DeepSeek Harness (DSH), so most contributions touch either the Host orchestration (`src/`) or the Web console (`src/client/`).

## Setup

```bash
pnpm install
pnpm verify   # typecheck + test + build + package:check — the same gate CI runs
```

Node `^22.19 || >=24`, pnpm 10.

## Ground rules

1. **Every change goes through `pnpm verify`.** CI runs exactly this; a red local run means a red PR.
2. **Money is integer micro-currency.** Never route amounts through binary floating point; use the existing decimal→micro helpers. One aggregate BigInt rounding per entry, never per-category.
3. **Security invariants are load-bearing.** If your change touches admission, reservations, the HTTP routes, tool filters, or snapshot projection, read `docs/architecture.md` §0 first and extend the tests that pin those fences:
   - unpriced routes block admission unless covered by a temporary authorization;
   - remote web clients are read-only and fail closed;
   - snapshots never leak attempt capabilities, execution prompts, or credentials;
   - employees are denied founder-only and spawn-capable tools;
   - output is never truncated mid-turn (reservations are accounting only).
4. **State schema changes need migration coverage.** `normalizeCompanyState` must stay idempotent for every older on-disk shape; add a case to `test/migration.test.ts`. Browser snapshot contract changes bump `schema_version` in both host and client parsers plus the round-trip tests.
5. **Version bumps are two-file edits:** `package.json` and the assertion in `scripts/verify-package.mjs`.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `ci:`, `refactor:`, `test:`). Keep subjects imperative and under ~72 characters.

## Pull requests

- Describe the failure mode or feature, not just the diff.
- New behavior needs a test that fails without the change.
- UI changes: mention which console tab/flow is affected and whether employee or founder views differ.
- Host changes: note whether the audit ledger gains a new event type.

## Releasing

Maintainers: bump the two version spots, run `pnpm verify && pnpm pack`, tag `v<version>`, push. The release workflow verifies and attaches the tarball to a GitHub Release.

## License

By contributing you agree your work is released under the repository's MIT license.
