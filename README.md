# cognito-client

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-19%20passing-brightgreen.svg)](#testing)

A generic, dependency-injected browser client for [AWS Cognito](https://aws.amazon.com/cognito/)
user pools — sign-up, confirmation, sign-in, session restore/refresh, sign-out, forgot/reset
password, and the `NEW_PASSWORD_REQUIRED` challenge. **No product coupling, no hardcoded
routes, no default targets — every dependency is injected.**

> **Why this exists:** AWS Amplify Auth is heavyweight and opinionated. The raw
> `amazon-cognito-identity-js` SDK is callback-based and untyped. This client wraps the
> SDK into a clean, typed, Promise-based surface with every product concern (storage,
> error messages, navigation, pool config) injected — so you own the UX and policy, and
> the client owns the Cognito mechanics.

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API reference](#api-reference)
  - [`CognitoClient`](#cognitoclient)
  - [`signUp(email, password, attributeList?)`](#signupemail-password-attributelist)
  - [`confirmSignUp(email, code)`](#confirmsignupemail-code)
  - [`signIn(email, password)`](#signinemail-password)
  - [`completeNewPassword(newPassword, userAttributes?)`](#completenewpasswordnewpassword-userattributes)
  - [`getSession()`](#getsession)
  - [`refreshSession()`](#refreshsession)
  - [`forgotPassword(email)`](#forgotpasswordemail)
  - [`confirmNewPassword(email, code, newPassword)`](#confirmnewpasswordemail-code-newpassword)
  - [`signOut()`](#signout)
  - [`redirectToLogin(loginUrl)`](#redirecttologinloginurl)
  - [Token accessors](#token-accessors)
  - [Types](#types)
- [Dependency injection](#dependency-injection)
- [The NEW_PASSWORD_REQUIRED challenge](#the-new_password_required-challenge)
- [Session persistence and the post-login redirect](#session-persistence-and-the-post-login-redirect)
- [Security model](#security-model)
- [Testing](#testing)
- [Development](#development)
- [Project layout](#project-layout)
- [Comparison with Amplify](#comparison-with-amplify)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

`cognito-client` provides a product-neutral Cognito lifecycle for browser applications.
It wraps the `amazon-cognito-identity-js` SDK (loaded as a browser global or injected as
a mock) behind a typed, Promise-based interface:

- **Sign-up** + email confirmation
- **Sign-in** with `NEW_PASSWORD_REQUIRED` challenge support
- **Session restore** (survives page reload / post-login redirect)
- **Session refresh** (uses cached refresh token)
- **Forgot password** + confirm new password
- **Sign-out** (clears tokens + SDK session)
- **Redirect to login** with `?returnTo=` preservation

Every product concern is injected:
- `sdk` — the `amazon-cognito-identity-js` namespace
- `userPoolId` / `clientId` — pool configuration (plain strings or lazy suppliers)
- `storage` — the `Storage` used for SDK persistence (bind `sessionStorage` so tokens
  never touch `localStorage`)
- `errorMapper` — maps SDK errors to your product's error copy
- `navigate` / `getCurrentPath` — navigation hooks for `redirectToLogin`

---

## Features

- **Fully dependency-injected** — no hardcoded pool IDs, no hardcoded routes, no hardcoded
  error messages. You own the product policy; the client owns the Cognito mechanics.
- **Promise-based** — wraps the callback-based SDK into clean async/await
- **TypeScript-native** — full types for every method, option, and SDK interface
- **NEW_PASSWORD_REQUIRED challenge** — surfaced as a `SignInResult.challenge`, not an error
- **Session persistence** — tokens survive the post-login redirect via the injected `Storage`
- **Lazy pool config** — `userPoolId` / `clientId` can be functions resolved at first use
  (for apps that load config at runtime)
- **Token safety** — runtime tokens live in memory only; the SDK session (refresh token)
  lives in the injected `Storage` (use `sessionStorage` so it clears on tab close)
- **Product-neutrality tested** — a test asserts the core source contains no product
  roles, routes, or copy
- **Zero runtime dependencies** — only dev dependencies (TypeScript, Vitest, jsdom)

---

## Install

```bash
npm install @clocklobster/cognito-client
# or
pnpm add @clocklobster/cognito-client
```

### Peer requirement

This client wraps [amazon-cognito-identity-js](https://www.npmjs.com/package/amazon-cognito-identity-js).
Install it in your app and pass the SDK namespace to the client constructor:

```bash
npm install amazon-cognito-identity-js
```

### Requirements

- **Browser environment** (uses `Storage`, `window` navigation)
- **TypeScript >= 5** (for type consumers; ships `.d.ts` files)
- `amazon-cognito-identity-js` loaded as a browser global or importable module

---

## Quick start

```typescript
import { CognitoClient } from '@clocklobster/cognito-client';
// Load the SDK — as a browser global, or via import:
// import * as AmazonCognitoIdentity from 'amazon-cognito-identity-js';

const cognito = new CognitoClient({
  // Pool configuration (plain strings or lazy suppliers)
  userPoolId: 'us-east-1_XXXXXXXXX',
  clientId: 'your-app-client-id',

  // The amazon-cognito-identity-js namespace
  sdk: AmazonCognitoIdentity,

  // Storage for the SDK's session (refresh token).
  // Use sessionStorage so tokens never touch localStorage and clear on tab close.
  storage: sessionStorage,

  // Map SDK errors to your app's error messages
  errorMapper: (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('NotAuthorizedException')) {
      return new Error('Incorrect email or password.');
    }
    if (msg.includes('UserNotFoundException')) {
      return new Error('No account found with that email.');
    }
    return new Error(msg || 'Authentication failed.');
  },

  // Navigation (used by redirectToLogin)
  navigate: (url) => (window.location.href = url),
  getCurrentPath: () => window.location.pathname + window.location.search,
});

// Sign up
await cognito.signUp('user@example.com', 'SecurePassword123!', [
  { Name: 'email', Value: 'user@example.com' },
]);

// Confirm sign-up
await cognito.confirmSignUp('user@example.com', '123456');

// Sign in
const result = await cognito.signIn('user@example.com', 'SecurePassword123!');
if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
  // Collect a new password from the user, then:
  const tokens = await cognito.completeNewPassword('NewSecurePassword456!', {
    // Optional: required attribute updates from the challenge
    name: 'Jane',
  });
  console.log('Signed in:', tokens.idToken);
} else {
  console.log('Signed in:', result.idToken);
}

// On page load (e.g. in your app bootstrap), restore the session:
const session = await cognito.getSession();
if (session) {
  console.log('Restored session for', session.user);
  console.log('ID token:', session.idToken);
}

// Sign out
cognito.signOut();
```

---

## Configuration

### `CognitoClientOptions`

| Option | Type | Required | Description |
|---|---|---|---|
| `userPoolId` | `string \| (() => string)` | yes | Cognito User Pool ID (e.g. `us-east-1_XXXXX`). Can be a lazy supplier resolved at first auth operation. |
| `clientId` | `string \| (() => string)` | yes | Cognito App Client ID. Can be a lazy supplier. |
| `sdk` | `CognitoSdk` | yes | The `amazon-cognito-identity-js` namespace (browser global or imported module). |
| `storage` | `Storage \| (() => Storage \| undefined)` | yes | The `Storage` used for ALL SDK persistence. Bind `sessionStorage` so tokens never touch `localStorage`. Can be a lazy supplier. |
| `errorMapper` | `(err: unknown) => Error` | yes | Maps SDK errors to your app's error messages. The SDK throws opaque errors; this is your chance to translate them. |
| `navigate` | `(url: string) => void` | yes | Navigation function used by `redirectToLogin`. Typically `(url) => window.location.href = url`. |
| `getCurrentPath` | `() => string` | no | Returns the current page path + query, used to build `?returnTo=`. Defaults to empty string (no returnTo). |

### Lazy suppliers

`userPoolId`, `clientId`, and `storage` accept either a plain value or a function. The
function is resolved at first auth operation (not at construction), so apps that load
config at runtime (e.g. from a fetched config endpoint) can supply a lazy supplier:

```typescript
const cognito = new CognitoClient({
  userPoolId: () => appConfig.cognito.userPoolId,
  clientId: () => appConfig.cognito.clientId,
  // ...
});
```

---

## API reference

### `CognitoClient`

```typescript
import { CognitoClient } from '@clocklobster/cognito-client';

const cognito = new CognitoClient(options);
```

---

### `signUp(email, password, attributeList?)`

Registers a new user in the Cognito user pool.

```typescript
const result = await cognito.signUp('user@example.com', 'Password123!', [
  { Name: 'email', Value: 'user@example.com' },
  { Name: 'phone_number', Value: '+14165551234' },
]);
// result: { userConfirmed: boolean, userSub: string }
```

- `attributeList` — array of `{ Name, Value }` Cognito attributes (defaults to `[]`)
- Returns `{ userConfirmed, userSub }` — `userConfirmed` is `false` if email/SMS
  verification is required before sign-in

---

### `confirmSignUp(email, code)`

Confirms a sign-up using the verification code sent to the user's email/SMS.

```typescript
await cognito.confirmSignUp('user@example.com', '123456');
```

---

### `signIn(email, password)`

Authenticates a user. Returns either tokens (success) or a `NEW_PASSWORD_REQUIRED`
challenge that must be completed via `completeNewPassword()`.

```typescript
const result = await cognito.signIn('user@example.com', 'Password123!');

if (result.challenge === null) {
  // Success — tokens are available
  console.log(result.idToken, result.accessToken);
} else if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
  // User must set a new permanent password
  console.log(result.userAttributes);
  console.log(result.requiredAttributes);
}
```

**Returns:** `SignInResult` — either:
- `{ challenge: null, idToken: string, accessToken: string }`, or
- `{ challenge: 'NEW_PASSWORD_REQUIRED', userAttributes, requiredAttributes }`

On success, the session is persisted to the injected `Storage` so it survives the
post-login redirect.

---

### `completeNewPassword(newPassword, userAttributes?)`

Completes a `NEW_PASSWORD_REQUIRED` challenge issued by `signIn()`. Throws if no
challenge is in flight.

```typescript
const tokens = await cognito.completeNewPassword('NewPassword456!', {
  name: 'Jane Doe',  // optional required attribute updates
});
// tokens: { idToken, accessToken }
```

- `userAttributes` — any required attribute updates from the challenge. The `sub`
  attribute is automatically scrubbed (Cognito rejects resending it).
- On success, tokens are stored and the challenge state is cleared.
- On failure, the challenge state is cleared and the user must sign in again.

---

### `getSession()`

Restores a cached session from the injected `Storage`. Used on page load to check
if the user is already authenticated.

```typescript
const session = await cognito.getSession();
if (session) {
  console.log('User:', session.user);
  console.log('ID token:', session.idToken);
  console.log('Access token:', session.accessToken);
} else {
  // Not authenticated — redirect to login
  cognito.redirectToLogin('/login.html');
}
```

**Returns:** `RestoredSession | null`

- On success: `{ idToken, accessToken, user }`
- On failure (stale/invalid session): signs out the SDK user, clears tokens, returns `null`
- On synchronous SDK throw (no cached refresh token): clears tokens, returns `null`

---

### `refreshSession()`

Refreshes the session using the cached refresh token. Safe to call even when the SDK's
`signInUserSession` has not been loaded into memory yet (e.g. an API call races the
page's own `getSession()` call).

```typescript
const tokens = await cognito.refreshSession();
// tokens: { idToken, accessToken }
```

**Returns:** `SessionTokens` — `{ idToken, accessToken }`

**Throws:** if there is no cached session or the refresh token is invalid.

---

### `forgotPassword(email)`

Initiates the forgot-password flow. Cognito sends a verification code to the user's
email/SMS. Resolves when the code has been sent (the `inputVerificationCode` callback
fires).

```typescript
await cognito.forgotPassword('user@example.com');
// Now prompt the user for the code + new password
```

---

### `confirmNewPassword(email, code, newPassword)`

Completes the forgot-password flow by submitting the verification code and a new password.

```typescript
await cognito.confirmNewPassword('user@example.com', '123456', 'NewPassword789!');
```

---

### `signOut()`

Signs out the current user from the SDK and clears all token/challenge state.

```typescript
cognito.signOut();
```

Clears:
- `idToken`, `accessToken`, `currentUser`
- `pendingChallengeUser` (any in-flight `NEW_PASSWORD_REQUIRED` challenge)

---

### `redirectToLogin(loginUrl)`

Signs out any stale Cognito session, then navigates to `loginUrl` with the current page
preserved as `?returnTo=` so the login page can send the user back after sign-in.

```typescript
cognito.redirectToLogin('/login.html');
// Navigates to: /login.html?returnTo=%2Fdashboard%3Ftab%3Dsettings
```

- `loginUrl` — the login page URL (product policy — the adapter owns this)
- Signs out first so the login form doesn't pick up a cached user whose tokens are dead
- Uses `getCurrentPath()` (if provided) to build the `?returnTo=` query parameter

---

### Token accessors

| Method | Returns | Description |
|---|---|---|
| `getUser()` | `string \| null` | The current user's username (or `null` if not signed in) |
| `getIdToken()` | `string \| null` | The current Cognito ID token JWT (or `null`) |
| `getAccessToken()` | `string \| null` | The current Cognito access token JWT (or `null`) |

These return `null` when no session is active. They read from in-memory state set by
`signIn()`, `completeNewPassword()`, `getSession()`, or `refreshSession()`.

---

### Types

```typescript
// SignIn result — either tokens (success) or a challenge
type SignInResult =
  | { challenge: null; idToken: string; accessToken: string }
  | {
      challenge: 'NEW_PASSWORD_REQUIRED';
      userAttributes: Record<string, unknown>;
      requiredAttributes: Record<string, unknown>;
    };

// Session tokens
interface SessionTokens {
  idToken: string;
  accessToken: string;
}

// Restored session (from getSession)
interface RestoredSession extends SessionTokens {
  user: string;
}

// The SDK surface the client uses (inject amazon-cognito-identity-js)
interface CognitoSdk {
  CognitoUserPool: new (data: { UserPoolId: string; ClientId: string; Storage?: Storage }) => CognitoUserPoolLike;
  CognitoUser: new (data: { Username: string; Pool: CognitoUserPoolLike; Storage?: Storage }) => CognitoUserLike;
  AuthenticationDetails: new (data: { Username: string; Password: string }) => unknown;
}

// Client options
interface CognitoClientOptions {
  userPoolId: string | (() => string);
  clientId: string | (() => string);
  sdk: CognitoSdk;
  storage: Storage | (() => Storage | undefined);
  errorMapper: (err: unknown) => Error;
  navigate: (url: string) => void;
  getCurrentPath?: () => string;
}
```

---

## Dependency injection

Every dependency is injected — the client has zero hardcoded values:

| Dependency | Purpose | Typical binding |
|---|---|---|
| `sdk` | The `amazon-cognito-identity-js` namespace | Browser global or `import * as` |
| `userPoolId` | Cognito User Pool ID | String from config/env |
| `clientId` | Cognito App Client ID | String from config/env |
| `storage` | SDK session persistence | `sessionStorage` (never `localStorage`) |
| `errorMapper` | SDK error → user-facing error | Your app's error message map |
| `navigate` | Page navigation for `redirectToLogin` | `(url) => window.location.href = url` |
| `getCurrentPath` | Current path for `?returnTo=` | `() => window.location.pathname + window.location.search` |

This means:
- **No hardcoded pool IDs** — different environments (dev/staging/prod) inject different pools
- **No hardcoded error messages** — your app owns the UX copy
- **No hardcoded routes** — your app owns the login URL and redirect logic
- **No hardcoded storage** — bind `sessionStorage` for tab-scoped sessions, or a custom
  `Storage` implementation for testing

---

## The NEW_PASSWORD_REQUIRED challenge

When a user signs in and Cognito requires a new permanent password (e.g. admin-created/
invited users in `FORCE_CHANGE_PASSWORD` state), `signIn()` does **not** throw an error.
Instead, it returns a challenge result:

```typescript
const result = await cognito.signIn(email, tempPassword);

if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
  // The user is authenticated but must set a new password.
  // Show a "set new password" form, then:
  const tokens = await cognito.completeNewPassword(newPassword, {
    name: 'Jane',  // optional required attributes
  });
  // tokens.idToken / tokens.accessToken are now available
}
```

Key details:
- The `CognitoUser` reference is held internally during the challenge — you don't need
  to re-authenticate to complete it
- The `sub` attribute is automatically scrubbed from `userAttributes` (Cognito rejects
  resending it — it's read-only/server-managed)
- On success, tokens are stored and the challenge state is cleared
- On failure, the challenge state is cleared and the user must sign in again

---

## Session persistence and the post-login redirect

Cognito's SDK persists the session (refresh token) to the injected `Storage`. This
client binds `sessionStorage` by convention so:

- **Runtime tokens live in memory only** — `idToken` / `accessToken` are never written
  to storage; they're held in the `CognitoClient` instance
- **The SDK session (refresh token) lives in `sessionStorage`** — so it survives the
  post-login redirect but clears when the tab closes
- **On page load**, call `getSession()` to restore the session from `sessionStorage`

```typescript
// App bootstrap (every page load):
const session = await cognito.getSession();
if (session) {
  // User is authenticated — render the app
  initApp(session);
} else {
  // Not authenticated — redirect to login
  cognito.redirectToLogin('/login.html');
}

// Login page (after successful signIn):
const result = await cognito.signIn(email, password);
if (result.challenge === null) {
  // Read ?returnTo= from the URL and navigate there
  const returnTo = new URLSearchParams(window.location.search).get('returnTo') || '/';
  window.location.href = returnTo;
}
```

---

## Security model

- **Runtime tokens in memory only** — `idToken` and `accessToken` are never written to
  `Storage`. They live in the `CognitoClient` instance and are cleared on sign-out or
  terminal failure.
- **SDK session in `sessionStorage`** — the refresh token persists in the injected
  `Storage` (bind `sessionStorage`, not `localStorage`, so it clears on tab close).
- **Terminal failure clears state** — a stale/invalid cached session triggers `signOut()`
  + `clearTokens()`, so no dead token state survives.
- **Sign-out is thorough** — calls `cognitoUser.signOut()` on the SDK AND clears all
  in-memory token/challenge state.
- **`redirectToLogin` signs out first** — so the login form doesn't pick up a cached
  user whose tokens are dead.
- **`sub` is scrubbed** — `completeNewPassword` strips the `sub` attribute from
  `userAttributes` before sending (Cognito rejects resending it).

---

## Testing

The suite uses [Vitest](https://vitest.dev/) with a `jsdom` environment and a mock SDK.
19 tests across 4 describe blocks:

| Describe block | Tests | Coverage |
|---|---|---|
| `CognitoClient - dependency injection` | 6 | Lazy pool config, lazy storage, SDK injection, error mapper |
| `CognitoClient - signIn / session` | 8 | signIn success, NEW_PASSWORD_REQUIRED challenge, completeNewPassword, getSession, refreshSession, forgotPassword, confirmNewPassword |
| `CognitoClient - sign-out / navigation` | 3 | signOut, redirectToLogin with ?returnTo=, stale session cleanup |
| `CognitoClient - product neutrality` | 2 | No product roles/routes on the prototype, no product terms in source |

```bash
npm test             # vitest run (jsdom, mock SDK — no real Cognito calls)
```

The **product-neutrality test** asserts that the `CognitoClient` source contains no
product-specific terms (roles, routes, copy) — this guarantees the core stays generic
as it evolves.

---

## Development

```bash
# Install dependencies
pnpm install

# Typecheck
pnpm run typecheck    # tsc --noEmit

# Run tests (jsdom + mock SDK — no real Cognito)
pnpm test             # vitest run

# Build (emit to dist/)
pnpm run build        # tsc -p tsconfig.build.json
```

### Requirements

- Node.js >= 18
- pnpm (or npm/yarn — the package has no runtime dependencies)
- TypeScript >= 5

---

## Project layout

```text
cognito-client/
├── src/
│   └── index.ts      # CognitoClient + all types (single file, ~400 lines)
├── test/
│   └── cognito-client.test.ts  # 19 tests — DI, signIn/session, sign-out/nav, neutrality
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── LICENSE
└── README.md
```

---

## Comparison with Amplify

| | `cognito-client` | AWS Amplify Auth |
|---|---|---|
| **Dependencies** | Zero runtime (you inject the SDK) | Heavyweight (~50 deps) |
| **Bundle size** | ~4KB (your code only) | ~100KB+ |
| **Error messages** | You own them (`errorMapper`) | Amplify's defaults |
| **Routes** | You own them (`navigate`) | Amplify's hosted UI / config |
| **Storage** | You choose (`sessionStorage` recommended) | Amplify's `localStorage` default |
| **Pool config** | String or lazy supplier | Static config at init |
| **NEW_PASSWORD_REQUIRED** | First-class challenge result | Handled internally |
| **Product coupling** | None (tested) | Amplify ecosystem assumptions |
| **TypeScript** | Full types, strict | Full types |

**When to use `cognito-client`:** you want a thin, typed, dependency-injected Cognito
wrapper that you fully control. You own the UX, the error messages, the storage strategy,
and the routing.

**When to use Amplify:** you want a batteries-included auth solution with hosted UI,
social providers, MFA, and the full Amplify ecosystem — and you're OK with the bundle
size and opinionated defaults.

---

## Contributing

Pull requests are welcome.

### Guidelines

1. Add or update tests for any change (Vitest, jsdom, mock SDK).
2. Ensure `pnpm run typecheck` and `pnpm test` pass.
3. Do not commit secrets, `.env` files, or `dist/` output.
4. Follow the existing code style (strict TypeScript, no `any`, dependency injection).
5. **Keep the core product-neutral** — the product-neutrality test must stay green. No
   product roles, routes, or copy in `src/index.ts`.

---

## License

[MIT](LICENSE) © Victor Salmon
