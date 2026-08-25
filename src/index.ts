/**
 * Generic browser Cognito lifecycle — product-neutral core.
 *
 * A shared Cognito client contract (sign-up, confirmation, sign-in,
 * restore/refresh, sign-out, reset, token state, and the
 * NEW_PASSWORD_REQUIRED challenge) WITHOUT product roles, routes, visible
 * copy, or default targets.
 *
 * Every dependency is injected:
 *   - `sdk` — the amazon-cognito-identity-js namespace (browser global,
 *     or a mock in tests).
 *   - `userPoolId` / `clientId` — pool configuration; may also be supplied as
 *     a lazy function resolved at initPool() time.
 *   - `storage` — the Storage used for ALL SDK persistence. Products bind
 *     `sessionStorage` here so tokens never touch `localStorage`.
 *   - `errorMapper` — maps SDK errors to product copy.
 *   - `navigate` / `getCurrentPath` — navigation hooks used by
 *     `redirectToLogin`.
 *
 * Invariants:
 *   - Runtime tokens live in memory ONLY; the supplied Storage holds the
 *     SDK's session (refresh token) so it survives the post-login redirect.
 *   - Terminal failure and sign-out clear token/challenge state.
 *   - `NEW_PASSWORD_REQUIRED` is surfaced as an authenticated challenge
 *     (`SignInResult.challenge`), not an error.
 */

/** SignIn result — either tokens (success) or a challenge that must be completed. */
export type SignInResult =
  | { challenge: null; idToken: string; accessToken: string }
  | {
      challenge: 'NEW_PASSWORD_REQUIRED';
      userAttributes: Record<string, unknown>;
      requiredAttributes: Record<string, unknown>;
    };

export interface SessionTokens {
  idToken: string;
  accessToken: string;
}

export interface RestoredSession extends SessionTokens {
  user: string;
}

/** Minimal structural surface of the SDK the core uses. */
export interface CognitoSdk {
  CognitoUserPool: new (data: {
    UserPoolId: string;
    ClientId: string;
    Storage?: Storage;
  }) => CognitoUserPoolLike;
  CognitoUser: new (data: {
    Username: string;
    Pool: CognitoUserPoolLike;
    Storage?: Storage;
  }) => CognitoUserLike;
  AuthenticationDetails: new (data: { Username: string; Password: string }) => unknown;
}

export interface CognitoUserPoolLike {
  signUp(
    username: string,
    password: string,
    attributeList: Array<{ Name: string; Value: string }>,
    validationData: unknown[] | null,
    callback: (err: unknown, result: { userConfirmed: boolean; userSub: string } | null) => void,
  ): void;
  getCurrentUser(): CognitoUserLike | null;
}

export interface CognitoUserLike {
  authenticateUser(
    authenticationDetails: unknown,
    callbacks: {
      onSuccess: (session: CognitoSessionLike, userConfirmationNecessary?: boolean) => void;
      onFailure: (err: unknown) => void;
      newPasswordRequired?: (
        userAttributes: Record<string, unknown>,
        requiredAttributes: Record<string, unknown>,
      ) => void;
    },
  ): void;
  getSession(callback: (err: unknown, session: CognitoSessionLike | null) => void): void;
  confirmRegistration(
    code: string,
    forceAliasCreation: boolean,
    callback: (err: unknown, result: unknown) => void,
  ): void;
  forgotPassword(callbacks: {
    onSuccess: () => void;
    onFailure: (err: unknown) => void;
    inputVerificationCode: (data?: unknown) => void;
  }): void;
  confirmPassword(
    code: string,
    newPassword: string,
    callbacks: { onSuccess: () => void; onFailure: (err: unknown) => void },
  ): void;
  signOut(): void;
  getUsername(): string;
  setSignInUserSession(session: CognitoSessionLike): void;
}

export interface CognitoSessionLike {
  getIdToken(): { getJwtToken(): string };
  getAccessToken(): { getJwtToken(): string };
  getRefreshToken(): { getToken(): string } | null;
  isValid(): boolean;
}

export interface CognitoClientOptions {
  /** Pool configuration — plain string or a lazy supplier resolved at initPool() time. */
  userPoolId: string | (() => string);
  clientId: string | (() => string);
  sdk: CognitoSdk;
  storage: Storage | (() => Storage | undefined);
  errorMapper: (err: unknown) => Error;
  navigate: (url: string) => void;
  /** Current page path + query, used to build the `?returnTo=` destination. */
  getCurrentPath?: () => string;
}

/**
 * Resolve a value that may be a lazy supplier, using the current value at the
 * point of call. This lets pool config and storage be supplied as functions
 * resolved at first auth operation instead of at construction.
 */
function resolveSupplier<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export class CognitoClient {
  private pool: CognitoUserPoolLike | null = null;
  private currentUser: string | null = null;
  private idToken: string | null = null;
  private accessToken: string | null = null;
  // Holds the CognitoUser mid-NEW_PASSWORD_REQUIRED challenge, set by signIn()
  // and consumed/cleared by completeNewPassword(). Null when no challenge is in
  // flight (or after signOut / failure).
  private pendingChallengeUser: CognitoUserLike | null = null;

  constructor(private readonly options: CognitoClientOptions) {}

  private get storage(): Storage | undefined {
    return resolveSupplier(this.options.storage) ?? undefined;
  }

  /**
   * Build the Storage option to spread into SDK constructors.
   * Returns an empty object when no storage is configured so the spread is a
   * no-op and the SDK falls back to its default storage behavior.
   */
  private buildStorageOption(): { Storage: Storage } | {} {
    return this.storage ? { Storage: this.storage } : {};
  }

  private initPool(): void {
    if (this.pool) return;
    // Resolve lazy pool-config suppliers HERE (first auth operation), not at
    // construction: product adapters may rely on runtime config that is not yet
    // available at import time. By resolving at first use, the pool always sees
    // the current values.
    this.pool = new this.options.sdk.CognitoUserPool({
      UserPoolId: resolveSupplier(this.options.userPoolId),
      ClientId: resolveSupplier(this.options.clientId),
      ...this.buildStorageOption(),
    });
  }

  /** Factory for all CognitoUser instances so they share the pool's session storage. */
  private newCognitoUser(username: string): CognitoUserLike {
    this.initPool();
    return new this.options.sdk.CognitoUser({
      Username: username,
      Pool: this.pool!,
      ...this.buildStorageOption(),
    });
  }

  signUp(
    email: string,
    password: string,
    attributeList: Array<{ Name: string; Value: string }> = [],
  ): Promise<{ userConfirmed: boolean; userSub: string }> {
    this.initPool();
    return new Promise((resolve, reject) => {
      this.pool!.signUp(email, password, attributeList, null, (err, result) => {
        if (err) return reject(this.options.errorMapper(err));
        resolve({
          userConfirmed: result!.userConfirmed,
          userSub: result!.userSub,
        });
      });
    });
  }

  confirmSignUp(email: string, code: string): Promise<void> {
    this.initPool();
    const cognitoUser = this.newCognitoUser(email);
    return new Promise((resolve, reject) => {
      cognitoUser.confirmRegistration(code, true, (err, _result) => {
        if (err) return reject(this.options.errorMapper(err));
        resolve();
      });
    });
  }

  signIn(email: string, password: string): Promise<SignInResult> {
    this.initPool();
    const authDetails = new this.options.sdk.AuthenticationDetails({
      Username: email,
      Password: password,
    });
    const cognitoUser = this.newCognitoUser(email);
    return new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          // Persist the session to the SDK's configured Storage (sessionStorage)
          // so that after the post-login redirect, getSession() can restore it.
          cognitoUser.setSignInUserSession(session);
          this.setTokensFromSession(session, email);
          resolve({ challenge: null, idToken: this.idToken!, accessToken: this.accessToken! });
        },
        onFailure: (err) => {
          reject(this.options.errorMapper(err));
        },
        newPasswordRequired: (userAttributes, requiredAttributes) => {
          // The user is authenticated but Cognito requires a new permanent password
          // (e.g. admin-created/invited users in FORCE_CHANGE_PASSWORD state). Surface
          // the challenge to the caller; the login page collects a new password and
          // calls completeNewPassword(). Keep the cognitoUser reference alive so the
          // challenge can be completed without re-authenticating.
          this.pendingChallengeUser = cognitoUser;
          resolve({
            challenge: 'NEW_PASSWORD_REQUIRED',
            userAttributes,
            requiredAttributes,
          });
        },
      });
    });
  }

  /**
   * Complete a NEW_PASSWORD_REQUIRED challenge issued by signIn().
   *
   * After collecting a new permanent password from the user, the login page calls
   * this with the new password. On success the tokens are stored (same as a
   * normal signIn) and the caller proceeds to its own landing routing.
   *
   * `userAttributes` carries any required attribute updates Cognito requested;
   * the `sub` claim is scrubbed (read-only, Cognito rejects resending it) while
   * anything else the challenge asked for passes through.
   */
  async completeNewPassword(
    newPassword: string,
    userAttributes: Record<string, unknown> = {},
  ): Promise<SessionTokens> {
    if (!this.pendingChallengeUser) {
      throw new Error('No pending password challenge. Please sign in again.');
    }
    const user = this.pendingChallengeUser;
    // Cognito rejects resending the `sub` attribute (it's read-only / server-managed).
    const { sub: _sub, ...safeAttrs } = userAttributes;
    return new Promise((resolve, reject) => {
      // `completeNewPasswordChallenge` exists at runtime on CognitoUser but is
      // omitted from the SDK type stubs (the SDK loads as a browser global).
      // Cast to access it.
      (user as unknown as {
        completeNewPasswordChallenge(
          newPassword: string,
          userAttributes: Record<string, unknown>,
          callbacks: {
            onSuccess(session: CognitoSessionLike): void;
            onFailure(err: unknown): void;
          },
        ): void;
      }).completeNewPasswordChallenge(newPassword, safeAttrs, {
        onSuccess: (session) => {
          // Persist the completed challenge session so the post-redirect page
          // can restore it via getSession().
          user.setSignInUserSession(session);
          this.setTokensFromSession(session, user.getUsername());
          this.pendingChallengeUser = null;
          resolve({ idToken: this.idToken!, accessToken: this.accessToken! });
        },
        onFailure: (err) => {
          this.pendingChallengeUser = null;
          reject(this.options.errorMapper(err));
        },
      });
    });
  }

  getSession(): Promise<RestoredSession | null> {
    this.initPool();
    const cognitoUser = this.pool!.getCurrentUser();
    if (!cognitoUser) return Promise.resolve(null);

    return new Promise((resolve) => {
      try {
        cognitoUser.getSession((err, session) => {
          if (err || !session || !session.isValid()) {
            // Terminal failure — a stale/invalid cached session must not
            // leave token state behind.
            cognitoUser.signOut();
            this.clearTokens();
            resolve(null);
            return;
          }
          this.setTokensFromSession(session, cognitoUser.getUsername());
          resolve({ idToken: this.idToken!, accessToken: this.accessToken!, user: this.currentUser! });
        });
      } catch {
        // SDK threw synchronously (e.g. no cached refresh token). Treat as unauthenticated.
        this.clearTokens();
        resolve(null);
      }
    });
  }

  refreshSession(): Promise<SessionTokens> {
    this.initPool();
    const cognitoUser = this.pool!.getCurrentUser();
    if (!cognitoUser) return Promise.reject(new Error('No cached session to refresh'));

    // Load the cached session first. If the id token is still valid, getSession
    // returns it. If it is expired, getSession uses the cached refresh token to
    // fetch a new one. This makes refreshSession safe even when the SDK's
    // signInUserSession has not been loaded into memory yet, e.g. an API call
    // races the page's own getSession() call.
    return new Promise((resolve, reject) => {
      cognitoUser.getSession((err, session) => {
        if (err || !session || !session.isValid()) {
          return reject(err ? this.options.errorMapper(err) : new Error('No valid cached session'));
        }
        this.setTokensFromSession(session, cognitoUser.getUsername());
        resolve({ idToken: this.idToken!, accessToken: this.accessToken! });
      });
    });
  }

  forgotPassword(email: string): Promise<void> {
    this.initPool();
    const cognitoUser = this.newCognitoUser(email);
    return new Promise((resolve, reject) => {
      cognitoUser.forgotPassword({
        onSuccess: () => resolve(),
        onFailure: (err) => reject(this.options.errorMapper(err)),
        inputVerificationCode: () => resolve(),
      });
    });
  }

  confirmNewPassword(email: string, code: string, newPassword: string): Promise<void> {
    this.initPool();
    const cognitoUser = this.newCognitoUser(email);
    return new Promise((resolve, reject) => {
      cognitoUser.confirmPassword(code, newPassword, {
        onSuccess: () => resolve(),
        onFailure: (err) => reject(this.options.errorMapper(err)),
      });
    });
  }

  signOut(): void {
    if (this.pool) {
      const cognitoUser = this.pool.getCurrentUser();
      if (cognitoUser) cognitoUser.signOut();
    }
    this.clearTokens();
  }

  private clearTokens(): void {
    this.idToken = null;
    this.accessToken = null;
    this.currentUser = null;
    this.pendingChallengeUser = null;
  }

  getUser(): string | null {
    return this.currentUser || null;
  }

  getIdToken(): string | null {
    return this.idToken || null;
  }

  getAccessToken(): string | null {
    return this.accessToken || null;
  }

  /**
   * Redirect to the login page preserving the current page as `?returnTo=` so
   * the login page can send the user back after a successful sign-in. Signs out
   * any stale Cognito session first (so the login form doesn't pick up a cached
   * user whose tokens are dead). The login URL and return-path validation are
   * product policy — the adapter owns them.
   */
  redirectToLogin(loginUrl: string): void {
    this.signOut();
    const current = this.options.getCurrentPath ? this.options.getCurrentPath() : '';
    const target = current ? `${loginUrl}?returnTo=${encodeURIComponent(current)}` : loginUrl;
    this.options.navigate(target);
  }

  private setTokensFromSession(session: CognitoSessionLike, username: string): void {
    this.idToken = session.getIdToken().getJwtToken();
    this.accessToken = session.getAccessToken().getJwtToken();
    this.currentUser = username;
  }
}
