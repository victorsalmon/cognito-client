# Contributing

Pull requests are welcome. This guide covers the local workflow, quality gates,
and release steps for `cognito-client`.

## Setup

```bash
pnpm install
```

Requires Node.js >= 18 (`.nvmrc` pins 22). pnpm 11 is pinned via the
`packageManager` field — enable corepack (`corepack enable`) if `pnpm` is not
already available.

## Test

```bash
pnpm test              # vitest — unit tests, mocked SDK, no network calls
pnpm test:property     # fast-check property tests
pnpm run typecheck     # tsc --noEmit (covers src + test + examples)
pnpm run build         # tsc -p tsconfig.build.json (emits dist/ + declarations)
```

`prepare` rebuilds `dist/` automatically after a local install, so a fresh
install also verifies the build compiles. The build must never move back to an
install-lifecycle hook (`preinstall`/`install`/`postinstall`): those run on
consumer machines during `npm install`, where this package's devDependencies
and `tsconfig.build.json` are absent, and would fail the install. Both typecheck and test must exit 0 before
opening a PR. No network access is required — the suite uses Vitest with a
`jsdom` environment and a mock SDK (no real Cognito calls).

## Pull requests

- Keep PRs small and focused — one concern per PR.
- Add or update tests for every behavior change; all tests must use the mocked SDK surface, never a live user pool.
- Keep the core product-neutral: no roles, routes, visible copy, or default targets in `src/`.
- Use obviously synthetic pool IDs, emails, and tokens in fixtures.
- Match the existing code style (strict TypeScript, ESM, no `any`, dependency injection).
- Update `README.md` and `CHANGELOG.md` when the public API or behavior changes.

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
examples and docs. CI runs a fail-closed secret scan — the canonical pattern
list lives in the `Secret scan` step of the `verify` job in
`.github/workflows/ci.yml`; re-run it locally when in doubt.

## Release checklist

1. Bump `version` in `package.json` per [Semantic Versioning](https://semver.org/).
2. Update `CHANGELOG.md` with a new versioned section
   (`## [x.y.z] - YYYY-MM-DD`, Keep a Changelog format) for the release.
3. Verify the build: `pnpm run build` exits 0 and `dist/` contains the fresh
   output (do not commit `dist/` — it ships via the `files` field).
4. Dry-run publish: `pnpm publish --dry-run` and confirm only `dist`,
   `README.md`, and `LICENSE` are packed.
5. Publish: `pnpm publish --access public`.
