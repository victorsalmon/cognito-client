# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and the latest published release. Older releases should be upgraded before requesting a backport.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use the repository host's private security-advisory channel or contact the maintainers privately through the project profile. Include reproduction steps, affected versions, impact, and any suggested mitigation. Do not include live credentials or customer data.

You can expect an acknowledgement within five business days. The maintainers will validate the report, coordinate a fix and disclosure timeline, and credit the reporter unless anonymity is requested.

## Scope

Reports are especially useful for:

- token leakage — runtime tokens reaching `localStorage`, logs, URLs, or error messages;
- session-restore flaws that accept forged, expired, or cross-user sessions;
- `NEW_PASSWORD_REQUIRED` challenge handling that leaves stale authenticated state;
- `redirectToLogin` open-redirect or `returnTo` validation flaws;
- error-mapper behavior that leaks user-enumeration or pool internals.

The project does not accept real secrets in test cases. Use obviously synthetic pool IDs, client IDs, and tokens, and never commit a live user-pool configuration.
