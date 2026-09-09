# Contributing

Pull requests are welcome. This guide covers the local workflow, quality gates,
and release steps for `cognito-client`.

## Prerequisites

- **Node.js 22** (see `.nvmrc`)
- **pnpm 11 via corepack** (`corepack enable`, then use `corepack pnpm ...`)
- No network access required for typecheck/tests — the suite uses Vitest with a
  `jsdom` environment and a mock SDK (no real Cognito calls)

## Develop / verify

Run from the repository root:

```bash
corepack pnpm install
corepack pnpm run typecheck   # tsc --noEmit (covers src + test + examples)
corepack pnpm test            # vitest run (jsdom, mock SDK)
corepack pnpm run build       # tsc -p tsconfig.build.json (emits to dist/)
```

`postinstall` rebuilds `dist/` automatically after install, so a fresh
`corepack pnpm install` also verifies the build compiles.

Both `corepack pnpm run typecheck` and `corepack pnpm test` must exit 0 before
opening a PR.

## Guidelines

1. Add or update tests for any change (Vitest, jsdom, mock SDK).
2. Ensure typecheck and tests pass (see command block above).
3. Do not commit secrets, `.env` files, or `dist/` output.
4. Follow the existing code style (strict TypeScript, no `any`, dependency
   injection).

## Product-neutrality rule

Keep the core (`src/index.ts`) product-neutral: no product-specific roles,
routes, or copy. The product-neutrality test suite asserts this and must stay
green. Put product policy (pool IDs, error messages, login URLs, redirect
targets, UX copy) in injected dependencies (`sdk`, `userPoolId` / `clientId`,
`storage`, `errorMapper`, `navigate` / `getCurrentPath`) or in consumer
examples — never in `src/`.

## No-secrets rule

Never commit secrets: no AWS credentials, access keys (`AKIA...`), private
keys, tokens, real pool IDs, `.env` files, or generated `dist/` output.
Use placeholder values (e.g. `us-east-1_XXXXXXXXX`, `your-app-client-id`) in
examples and docs. CI runs a fail-closed secret scan — re-run it locally when
in doubt:

```bash
grep -rE -n --exclude-dir=.git --exclude-dir=node_modules -e 'AKIA[0-9A-Z]{16}' -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -- .
```

## Release checklist

1. Bump `version` in `package.json` per [Semantic Versioning](https://semver.org/).
2. Update `CHANGELOG.md` under `[Unreleased]` → move entries to a new
   versioned section (`## [x.y.z] - YYYY-MM-DD`, Keep a Changelog format).
3. Verify the build: `corepack pnpm run build` exits 0 and `dist/` contains the
   fresh output (do not commit `dist/` — it ships via the `files` field).
4. Dry-run publish: `corepack pnpm publish --dry-run` and confirm only `dist`,
   `README.md`, and `LICENSE` are packed.
5. Publish: `corepack pnpm publish --access public`.
