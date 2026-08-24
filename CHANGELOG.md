# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
