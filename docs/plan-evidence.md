# Plan evidence — cognito-client-0-guidance-ci-hardening

Scope (2026.09.04 plan): fix the unvalidated `returnTo` redirect guidance and add
CI audit gates plus consumer data-handling docs without touching `src/` or
`test/`. Section 5 below additionally records the 2026-09-21 mutation-hardening
round, which intentionally changed `src/` and `test/`.

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
- `dependency-audit (advisory)` — `corepack pnpm audit --audit-level=high`
  with `continue-on-error: true`. Deliberately kept advisory by owner
  decision (2026-09-19) even though the dev chain is now remediated:
  `pnpm-workspace.yaml` overrides pin `fast-uri` to 3.1.6 and `qs` to 6.16.0,
  and both `pnpm audit --audit-level=high` and `--audit-level=critical`
  report "No known vulnerabilities found" (verified 2026-09-20). Promotion to
  blocking at `high` (previously recorded as a follow-up) was explicitly
  declined, so future dev-only advisories (e.g. `fast-uri` via
  `@stryker-mutator`/`ajv`, GHSA-jqff-g426-hqxp) stay visible without turning
  a required check red.
- `consumer-install smoke` — packs the tarball, installs it into a fresh temp
  project offline (local path only, no publish), and imports `dist/index.js`,
  so a consumer-breaking install hook or `files` drift fails CI even though it
  is invisible to source-side typecheck/build/test.
- `secret-scan` — fail-closed `grep -rE` over tracked files for AWS keys,
  private-key blocks, and `xox`/`ghp_`/`sk-` token prefixes; exits non-zero
  on any match.
- `docs-lint` — asserts `docs/plan-evidence.md` exists, the README
  post-login example contains the validated `returnTo` guard
  (`startsWith('/')` + `startsWith('//')` rejection), and no
  `window.location.href = returnTo` line survives without the guard.

## 4. Validation (docs + CI attempt, 2026-09-20)

- `npx tsc --noEmit` — exit 0.
- `npx vitest run` — exit 0 (48 passed, 2 files, at that time).
- `npx tsc -p tsconfig.build.json --noEmit` — exit 0.
- `git diff --check` — exit 0.
- `src/` and `test/` untouched by that attempt (docs + workflow + README only).
  That claim holds for the 2026-09-20 attempt; the mutation round below
  intentionally changed `src/` and `test/`.

## 5. Mutation hardening round (2026-09-21)

Incremental Stryker run (`stryker.config.json`, `mutate: src/**/*.ts`,
`coverageAnalysis: perTest`, `ignoreStatic: true`), vitest `4.1.11` with
`@stryker-mutator/vitest-runner` `10.0.0`. The fail-closed canary was run
before and after: no run had `Killed == 0` with survivors, no non-`NoCoverage`
mutant reported `testsCompleted == 0`, and no run printed
`Ran 0.00 tests per mutant` (the vitest-5 collapse signature).

| Metric | Baseline (incremental) | Final (incremental) |
|---|---|---|
| Total mutants | 206 | 199 |
| Killed | 179 | 192 |
| Survived | 19 | 3 |
| No coverage | 4 | 0 |
| Mutation score (total / covered) | 88.61% / 90.40% | 98.46% / 98.46% |

Tests: 68 → 82 (`pnpm test`), all green; `pnpm run typecheck` and
`pnpm run build` green.

### Test gaps closed

Focused assertions, one file at a time, in `test/cognito-client.test.ts` and
`test/cognito-client.property.test.ts`:

- `isTokenExpired`: undecodable / non-JSON / empty payload (the `catch` path was
  never entered), two-part tokens, a non-finite `exp` (`1e999` → `Infinity`),
  and deterministic skew-boundary cases driven by the explicit `nowMs` argument.
- `buildStorageOption`: an omitted storage hook in a non-browser runtime must
  not throw and must pass no `Storage`.
- `ensureSession`: a `getSession()` that rejects because `initPool()` rejects
  (storage misconfiguration) still resolves `null` and redirects once.
- Pool initialization: every entry point that builds a `CognitoUser`
  (`signIn`, `confirmSignUp`, `forgotPassword`, `confirmNewPassword`) creates
  the pool once and shares that exact pool with the user.
- `signIn` fail-closed reset: a new attempt clears prior tokens and any pending
  challenge *before* the SDK responds.
- `refreshSession`: a terminal failure clears the tokens cached by an earlier
  sign-in.
- `forgotPassword` / `confirmNewPassword`: the `onFailure` path rejects with the
  mapped error (previously only the success path was exercised).

### Equivalent logic removed (behavior-preserving)

- `assertSessionStorageOnly` no longer early-returns on an empty storage: the
  remaining `storage === localStorage` comparison can never match `undefined`,
  so the guard was unreachable logic, not a safety check.
- `signIn`, `confirmSignUp`, `forgotPassword`, `confirmNewPassword` no longer
  call `initPool()` before `newCognitoUser()`; the factory already initializes
  the pool first, so the leading calls were redundant duplicates.

### Surviving mutants (documented, not suppressed)

| Location | Mutator | Why it is equivalent |
|---|---|---|
| `src/index.ts:184:9` | ConditionalExpression | Replacing `if (parts.length < 2) return true;` with `if (false)` is unobservable: with fewer than two parts `parts[1]` is `undefined`, so `parts[1].replace(...)` throws and the surrounding `catch` returns `true` anyway. The guard is kept as the explicit fail-closed statement for malformed tokens. |
| `src/index.ts:190:9` | ConditionalExpression | Replacing `if (typeof payload.exp !== 'number' \|\| !Number.isFinite(payload.exp))` with `if (false \|\| !Number.isFinite(payload.exp))` is a Boolean identity: `Number.isFinite` is strict, so `typeof x !== 'number'` implies `!Number.isFinite(x)` and the first disjunct is subsumed. |
| `src/index.ts:331:11` | CallExpression | The `clearTokens()` in `signIn`'s `onFailure` is a fail-closed backstop at the SDK trust boundary. Within one `authenticateUser` call the SDK delivers exactly one terminal callback, and the attempt-start reset already cleared any prior token/challenge state, so the second clear is unobservable for a well-behaved SDK. The only distinguishing input is a superseded attempt reporting a late failure after a newer attempt authenticated — that behavior is deliberately *not* locked in as an invariant. |

## 6. Validation (mutation round, 2026-09-21)

- `pnpm run typecheck` — exit 0.
- `pnpm test` — exit 0 (82 passed, 4 files).
- `pnpm run build` — exit 0.
- `git diff --check` — exit 0.
