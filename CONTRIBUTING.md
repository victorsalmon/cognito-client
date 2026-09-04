# Contributing

## Setup

```bash
pnpm install
```

Requires Node.js >= 18 (see `.nvmrc`).

## Test

```bash
pnpm test              # vitest — unit tests, mocked SDK, no network calls
pnpm test:property     # fast-check property tests
pnpm run typecheck     # tsc --noEmit
pnpm run build         # emit dist/ + declarations
```

## Pull requests

- Keep PRs small and focused — one concern per PR.
- Add or update tests for every behavior change; all tests must use the mocked SDK surface, never a live user pool.
- Keep the core product-neutral: no roles, routes, visible copy, or default targets in `src/`.
- Use obviously synthetic pool IDs, emails, and tokens in fixtures.
- Match the existing code style (strict TypeScript, ESM).
- Update `README.md` and `CHANGELOG.md` when the public API or behavior changes.
