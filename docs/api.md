# API reference — `@clocklobster/cognito-client`

Method-level companion to the [README quick start](../README.md#quick-start) and
[README API reference](../README.md#api-reference). For consumer wiring
(constructor options, `sessionStorage` binding, `errorMapper`, navigation hooks)
see the [README quick start](../README.md#quick-start).

Token-lifecycle invariants (all methods):

- Runtime tokens (`idToken`, `accessToken`, `currentUser`) live in memory only
  on the `CognitoClient` instance; the injected `Storage` holds the SDK session
  (refresh token) so it survives the post-login redirect.
- Terminal failure and `signOut()` clear token/challenge state
  (`idToken`, `accessToken`, `currentUser`, pending `NEW_PASSWORD_REQUIRED` user).
- `NEW_PASSWORD_REQUIRED` is surfaced as an authenticated
  `SignInResult.challenge`, never thrown as an error.
- `getSession()` / `refreshSession()` validate through the SDK: a stale/invalid
  cached session triggers `cognitoUser.signOut()` + in-memory clear before
  resolving `null` / rejecting.

```typescript
import { CognitoClient } from '@clocklobster/cognito-client';

const cognito = new CognitoClient({
  userPoolId: 'us-east-1_XXXXXXXXX',
  clientId: 'your-app-client-id',
  sdk: AmazonCognitoIdentity,
  storage: sessionStorage,
  errorMapper: (err) => new Error(err instanceof Error ? err.message : String(err)),
  navigate: (url) => (window.location.href = url),
  getCurrentPath: () => window.location.pathname + window.location.search,
});
```

## `signUp(email, password, attributeList?)`

```typescript
signUp(
  email: string,
  password: string,
  attributeList?: Array<{ Name: string; Value: string }>,
): Promise<{ userConfirmed: boolean; userSub: string }>
```

- Registers `email` in the pool via `pool.signUp(email, password, attributeList, null, cb)`.
- `attributeList` defaults to `[]`.
- Returns `{ userConfirmed, userSub }`; `userConfirmed === false` means
  email/SMS verification is still required before sign-in.
- Throws: mapped `errorMapper(err)` when the SDK reports an error.

## `confirmSignUp(email, code)`

```typescript
confirmSignUp(email: string, code: string): Promise<void>
```

- Confirms registration via `confirmRegistration(code, true, cb)` on a
  pool-bound `CognitoUser` for `email`.
- Returns: `void` on success.
- Throws: mapped `errorMapper(err)` on SDK failure.

## `signIn(email, password)`

```typescript
signIn(email: string, password: string): Promise<SignInResult>
```

where

```typescript
type SignInResult =
  | { challenge: null; idToken: string; accessToken: string }
  | {
      challenge: 'NEW_PASSWORD_REQUIRED';
      userAttributes: Record<string, unknown>;
      requiredAttributes: Record<string, unknown>;
    };
```

- Authenticates via `authenticateUser` with `AuthenticationDetails({ Username: email, Password: password })`.
- On `onSuccess`: persists the session via `setSignInUserSession(session)` so
  `getSession()` survives the post-login redirect, caches tokens in memory, and
  resolves `{ challenge: null, idToken, accessToken }`.
- On `newPasswordRequired`: holds the `CognitoUser` as the pending challenge
  user (no re-authentication needed) and resolves
  `{ challenge: 'NEW_PASSWORD_REQUIRED', userAttributes, requiredAttributes }`.
- Fail-closed across attempts: starting a `signIn()` clears any prior
  in-flight `NEW_PASSWORD_REQUIRED` challenge and prior in-memory tokens
  (`idToken`, `accessToken`, `currentUser`) before authenticating; `onFailure`
  clears the pending challenge and in-memory tokens before rejecting, so
  `getUser()` / `getIdToken()` / `getAccessToken()` return `null` and a later
  `completeNewPassword()` throws the no-pending-challenge error. `onSuccess`
  leaves no pending challenge behind.
- Throws: mapped `errorMapper(err)` on `onFailure`. Does not throw for the
  challenge path.

## `completeNewPassword(newPassword, userAttributes?)`

```typescript
completeNewPassword(
  newPassword: string,
  userAttributes?: Record<string, unknown>,
): Promise<SessionTokens>
```

- Completes the `NEW_PASSWORD_REQUIRED` challenge issued by `signIn()` via
  `completeNewPasswordChallenge(newPassword, safeAttrs, { onSuccess, onFailure })`.
- `userAttributes` defaults to `{}`; the read-only `sub` claim is scrubbed
  before sending (Cognito rejects resending it), all other keys pass through.
- On success: persists via `setSignInUserSession`, caches tokens, clears the
  pending challenge user, resolves `{ idToken, accessToken }`.
- Throws: plain `Error('No pending password challenge. Please sign in again.')`
  when no challenge is in flight; mapped `errorMapper(err)` on SDK failure (and
  the pending challenge is cleared so the caller must sign in again).

## `getSession()`

```typescript
getSession(): Promise<RestoredSession | null>
```

where `RestoredSession` is `{ idToken: string; accessToken: string; user: string }`.

- Restores the cached session from `pool.getCurrentUser()` + `getSession(cb)`.
- Returns `null` immediately when there is no cached user.
- On valid session: caches tokens in memory, resolves
  `{ idToken, accessToken, user }`.
- On stale/invalid session (`err`, `null` session, or `!session.isValid()`):
  calls `cognitoUser.signOut()`, clears in-memory tokens, resolves `null`.
- On synchronous SDK throw (e.g. no cached refresh token): calls
  `cognitoUser.signOut()` (parity with the invalid-session branch, so
  SDK-persisted stale state is removed) plus clears in-memory
  tokens, resolves `null`. Never rejects for a missing session.

## `ensureSession(loginUrl)`

```typescript
ensureSession(loginUrl: string): Promise<RestoredSession | null>
```

- Canonical async page-load gate for protected pages. Delegates to
  `getSession()`: a live session is returned (the SDK transparently refreshes
  via the stored refresh token when the ID token expired but the refresh token
  is alive — seamless, no redirect).
- On a dead session (`null` or thrown): calls `redirectToLogin(loginUrl)`
  (which signs out stale state and preserves `?returnTo=`) before any API fetch
  fires, then resolves `null`.
- Returns: `RestoredSession | null`. Never throws.

## `refreshSession()`

```typescript
refreshSession(): Promise<SessionTokens>
```

where `SessionTokens` is `{ idToken: string; accessToken: string }`.

- Loads the cached session via `pool.getCurrentUser()` + `getSession(cb)`. When
  the ID token is expired the SDK uses the cached refresh token to fetch a new
  one, so this is safe even when the SDK's in-memory session has not been
  loaded yet (e.g. an API call races the page's own `getSession()`).
- On valid session: caches tokens in memory, resolves `{ idToken, accessToken }`.
- Throws: `Error('No cached session to refresh')` when there is no cached user;
  mapped `errorMapper(err)` when the SDK reports an error; plain
  `Error('No valid cached session')` when the session is missing/invalid. On
  terminal failure it signs out the SDK user and clears in-memory tokens first.

## `forgotPassword(email)`

```typescript
forgotPassword(email: string): Promise<void>
```

- Starts the reset flow on a pool-bound `CognitoUser` for `email` via
  `forgotPassword({ onSuccess, onFailure, inputVerificationCode })`.
- Resolves `void` when Cognito accepts the request (`onSuccess`) or when the
  SDK asks for the verification code (`inputVerificationCode` — the caller then
  prompts for code + new password).
- Throws: mapped `errorMapper(err)` on `onFailure`.

## `confirmNewPassword(email, code, newPassword)`

```typescript
confirmNewPassword(email: string, code: string, newPassword: string): Promise<void>
```

- Completes the reset flow via `confirmPassword(code, newPassword, { onSuccess, onFailure })`
  on a pool-bound `CognitoUser` for `email`.
- Returns: `void` on success.
- Throws: mapped `errorMapper(err)` on SDK failure.

## `signOut()`

```typescript
signOut(): void
```

- Signs out the SDK's cached user (`pool.getCurrentUser()?.signOut()`, guarded
  when no pool has been initialised yet) and clears all in-memory
  token/challenge state (`idToken`, `accessToken`, `currentUser`,
  pending challenge user).
- Returns `void`. Never throws for the missing-user case.

## `redirectToLogin(loginUrl)`

```typescript
redirectToLogin(loginUrl: string): void
```

- Calls `signOut()` first (so the login form never picks up a cached user whose
  tokens are dead), then navigates via the injected `navigate` hook.
- Preserves the current page (from injected `getCurrentPath()`, or `''` when
  unprovided) as `?returnTo=<encodeURIComponent(current)>`; when there is no
  current path it navigates to `loginUrl` unchanged.
- Returns `void`. Product policy (login URL, return-path validation) belongs to
  the adapter: consumers must validate `?returnTo=` as a same-origin path
  (must start with `/`, must not start with `//`, must not contain `\` or an
  absolute URL — fall back to `/`) before navigating. See
  `docs/plan-evidence.md` and the README post-login redirect example.

## Token accessors

```typescript
getUser(): string | null
getIdToken(): string | null
getAccessToken(): string | null
```

- Read in-memory state set by `signIn()`, `completeNewPassword()`,
  `getSession()`, or `refreshSession()`; each returns `null` when no session is
  active or after `signOut()` / terminal-failure cleanup.

## `isTokenExpired(token, nowMs?)`

```typescript
isTokenExpired(token: string, nowMs?: number): boolean
```

- Fail-closed JWT expiry probe with a 60-second clock-skew tolerance. No
  signature verification (cryptographic validation belongs to the backend/SDK;
  this is a render-gating heuristic).
- Returns `true` when the token is expired, unparseable, not a JWT (fewer than
  two `.` segments), or missing a finite numeric `exp` claim; otherwise
  compares `exp * 1000 <= nowMs + 60_000` (`nowMs` defaults to `Date.now()`).
- Never throws.

## `assertSessionStorageOnly(storage)`

```typescript
assertSessionStorageOnly(storage: Storage | undefined): void
```

- Fail-closed storage guard: rejects the global `localStorage` because refresh
  tokens must persist in `sessionStorage` only — `localStorage` survives tab
  close and widens the blast radius of a stolen refresh token.
- Returns `void` for `undefined` (non-browser runtimes may omit storage) and
  for any adapter that is not the global `localStorage`.
- Throws: `Error('cognito-client: refresh tokens must use sessionStorage; localStorage is forbidden.')`
  when `storage === globalThis.localStorage`. `CognitoClient` calls this during
  pool/SDK construction, so a `localStorage` adapter throws at first auth use.
