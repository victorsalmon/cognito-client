# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `ensureSession(loginUrl)` canonical async page-load gate: validates the
  session through the SDK (transparent refresh when the refresh token is
  alive), otherwise signs out, redirects to `loginUrl` with `?returnTo=`
  preservation, and returns `null` — before any API fetch fires. Never
  throws. Prevents the reload-after-timeout flash where a stale cached token
  passed a sync presence check and private data rendered before the 401 path
  redirected.
- `isTokenExpired(token, nowMs?)` fail-closed JWT expiry probe (no signature
  verification): `true` when expired, unparseable, or missing a numeric `exp`.
- `docs/api.md` per-method reference (signatures, returns/throws, token-lifecycle
  invariants) linked back to the README quick start.

### Changed

- Hardened publish metadata in `package.json`: added `engines` (`node >= 18`),
  `exports` map (`./dist/index.js` + types), `sideEffects: false`, and included
  `README.md` and `LICENSE` alongside `dist` in `files`. No script or dependency
  changes.

## [1.0.0] - 2026-08-23

### Added

- Sign-up and email/SMS confirmation (`signUp`, `confirmSignUp`).
- Sign-in with `NEW_PASSWORD_REQUIRED` challenge support and `completeNewPassword`.
- Session restore (`getSession`) and refresh (`refreshSession`) using the cached refresh token.
- Forgot password and confirm new password flow (`forgotPassword`, `confirmNewPassword`).
- Sign-out that clears tokens and the SDK session (`signOut`).
- `redirectToLogin` with `?returnTo=` preservation for post-login navigation.
- Dependency-injected design: SDK namespace, pool config, storage, error mapper, and navigation hooks are all supplied by the consumer.
- Product-neutrality tests to keep the core free of product-specific roles, routes, and copy.
