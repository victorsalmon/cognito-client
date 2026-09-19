# Plan evidence — cognito-client-0-guidance-ci-hardening

Scope: fix the unvalidated `returnTo` redirect guidance and add CI audit
gates plus consumer data-handling docs without touching `src/` or `test/`.

## 1. Validated `returnTo` pattern (same-origin, fail-closed)

Consumers must validate `?returnTo=` before assigning to
`window.location.href`. The open-redirect recipe (`href = returnTo` with no
check) is not safe: an attacker can craft
`/login.html?returnTo=https://evil.example/phish` and steal trust after login.

Validated consumer pattern (also used in `README.md` post-login example):

```typescript
// Validate ?returnTo= before navigating: same-origin path only.
const raw = new URLSearchParams(window.location.search).get('returnTo') || '/';
const returnTo =
  raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/';
window.location.href = returnTo;
```

Rules:

- MUST start with `/` (same-origin path). Reject absolute URLs
  (`https://…`, `http://…`), custom schemes (`javascript:…`, `data:…`), and
  bare relative paths (`dashboard`, `../x`).
- MUST NOT start with `//` (protocol-relative URL — inherits the attacker's
  host).
- MUST NOT contain `\` (backslash normalisation bypass in some browsers).
- Fail closed: any rejection falls back to `'/'`.
- The SDK intentionally does not validate for you: `redirectToLogin(loginUrl)`
  only preserves `?returnTo=<encodeURIComponent(current)>` and navigates via
  the injected `navigate` hook. Return-path allowlisting is adapter/product
  policy — see `docs/api.md` (`redirectToLogin` section). Consumers that need
  stricter policy (explicit allowlist of paths) should check membership before
  navigating.

Denial behavior (focused check): `https://evil.example/`,
`//evil.example/x`, `javascript:alert(1)`, `\\evil`, `dashboard`, and empty
values all resolve to `'/'`; only `/` and `/dashboard?tab=settings`-style
same-origin paths pass through.

## 2. Consumer data-handling notes

- **Runtime tokens live in memory only** — `idToken` / `accessToken` (and
  `currentUser`) are held on the `CognitoClient` instance. They are never
  written to `Storage`, `localStorage`, cookies, or logs. `signOut()` and
  terminal-failure cleanup (`getSession()` / `refreshSession()` on a
  stale/invalid session) clear them.
- **The SDK session (refresh token) is `sessionStorage`-bound by convention**
  — bind the injected `storage` to `sessionStorage`, not `localStorage`, so
  the session survives the post-login redirect but clears when the tab closes.
  Construct with `storage: sessionStorage` (see `docs/api.md` header example).
- **On page load call `getSession()`** to restore from `sessionStorage`; use
  `ensureSession(loginUrl)` as the page-load gate so a dead session redirects
  via `redirectToLogin()` before any API fetch fires.
- **Do not persist tokens yourself** — do not copy `getIdToken()` /
  `getAccessToken()` into storage, URLs, or telemetry. Keep them in memory
  and re-read via the accessors or `refreshSession()` when expired
  (`isTokenExpired()` is a fail-closed render-gating heuristic only; real
  signature validation belongs to the backend/SDK).

## 3. CI audit gates

`.github/workflows/ci.yml` (`verify` job) now runs, after typecheck/build/test:

- `dependency-audit (blocking)` — `corepack pnpm audit --audit-level=critical`
  (fails CI on critical advisories).
- `dependency-audit (advisory)` — `corepack pnpm audit --audit-level=high`,
  now blocking (no `continue-on-error`): the dev-chain advisories are
  remediated via `pnpm-workspace.yaml` overrides pinning `fast-uri` to 3.1.6
  and `qs` to 6.16.0, so `pnpm audit` (and `--audit-level=high`) report no
  known vulnerabilities. Previously advisory with `continue-on-error: true`
  while 4 high + 3 moderate advisories (e.g. `fast-uri` via
  `@stryker-mutator`/`ajv`, GHSA-jqff-g426-hqxp) were open; promotion to
  blocking landed together with the override remediation (2026-09-19
  toolchain change: vitest 5.x + GHA v7).
- `secret-scan` — fail-closed `grep -rE` over tracked files for AWS keys,
  private-key blocks, and `xox`/`ghp_`/`sk-` token prefixes; exits non-zero
  on any match.
- `docs-lint` — asserts `docs/plan-evidence.md` exists, the README
  post-login example contains the validated `returnTo` guard
  (`startsWith('/')` + `startsWith('//')` rejection), and no
  `window.location.href = returnTo` line survives without the guard.

## 4. Validation (this attempt)

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` — exit 0 (48 passed, 2 files).
- `npx tsc -p tsconfig.build.json --noEmit` — exit 0.
- `git diff --check` — exit 0.
- `src/` and `test/` untouched (docs + workflow + README only).
