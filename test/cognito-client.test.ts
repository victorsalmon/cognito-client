import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitoClient, type CognitoSdk } from '../src/index';

// ─── Minimal in-memory SDK mock ──────────────────────────────────────────────
// These tests inject the mock SDK directly through the constructor. This is the
// whole point of the generic core: every dependency (SDK, storage, error
// mapper, navigation) arrives through the options.

interface ConstructedUserArgs {
  Username: string;
  Pool: unknown;
  Storage?: Storage;
}

interface ConstructedPoolArgs {
  UserPoolId: string;
  ClientId: string;
  Storage?: Storage;
}

function makeSession(idToken: string, accessToken: string, refreshToken = 'mock-refresh-token') {
  return {
    isValid: () => true,
    getIdToken: () => ({ getJwtToken: () => idToken }),
    getAccessToken: () => ({ getJwtToken: () => accessToken }),
    getRefreshToken: () => ({ getToken: () => refreshToken }),
  };
}

function installMockSdk(overrides: {
  authenticateUser?: (callbacks: any) => void;
  getSession?: (cb: (err: unknown, session: unknown) => void) => void;
  completeNewPasswordChallenge?: (pwd: string, attrs: unknown, callbacks: any) => void;
  invalidSession?: boolean;
  noCurrentUser?: boolean;
}) {
  const captured: { pools: ConstructedPoolArgs[]; users: ConstructedUserArgs[]; setSignInUserSessionCalls: unknown[]; signOutCalls: number; poolInstances: any[] } = {
    pools: [],
    users: [],
    setSignInUserSessionCalls: [],
    signOutCalls: 0,
    poolInstances: [],
  };

  let currentUserInstance: any = null;

  const CognitoUserPool = vi.fn(function (this: any, data: ConstructedPoolArgs) {
    captured.pools.push(data);
    captured.poolInstances.push(this);
    this.data = data;
    this.signUp = vi.fn(
      (_email: string, _password: string, attributeList: unknown[], _attrs: unknown, cb: (err: unknown, result: unknown) => void) => {
        cb(null, { userConfirmed: false, userSub: 'sub-123' });
      },
    );
    this.getCurrentUser = vi.fn(() =>
      overrides.noCurrentUser ? null : currentUserInstance ?? new CognitoUser({ Username: 'test@example.com', Pool: this }),
    );
  });

  const CognitoUser = vi.fn(function (this: any, data: ConstructedUserArgs) {
    captured.users.push(data);
    this.Username = data.Username;
    this.Pool = data.Pool;
    this.Storage = data.Storage;
    this.getUsername = () => data.Username;
    this.setSignInUserSession = vi.fn((session: unknown) => {
      captured.setSignInUserSessionCalls.push(session);
    });
    this.signOut = vi.fn(() => {
      captured.signOutCalls++;
    });
    this.authenticateUser = vi.fn((_details: unknown, callbacks: any) => {
      if (overrides.authenticateUser) {
        overrides.authenticateUser(callbacks);
      } else {
        callbacks.onSuccess(makeSession('mock-id-token', 'mock-access-token'));
      }
    });
    this.getSession = vi.fn((cb: (err: unknown, session: unknown) => void) => {
      if (overrides.getSession) {
        overrides.getSession(cb);
      } else {
        cb(null, overrides.invalidSession ? { isValid: () => false } : makeSession('restored-id-token', 'restored-access-token'));
      }
    });
    this.confirmRegistration = vi.fn((_code: string, _force: boolean, cb: (err: unknown, result: unknown) => void) => cb(null, 'SUCCESS'));
    this.forgotPassword = vi.fn(({ onSuccess }: any) => onSuccess());
    this.confirmPassword = vi.fn((_code: string, _pass: string, { onSuccess }: any) => onSuccess());
    this.completeNewPasswordChallenge = vi.fn((_pwd: string, attrs: unknown, callbacks: any) => {
      if (overrides.completeNewPasswordChallenge) {
        overrides.completeNewPasswordChallenge(_pwd, attrs, callbacks);
      } else {
        callbacks.onSuccess(makeSession('challenge-id-token', 'challenge-access-token', 'challenge-refresh-token'));
      }
    });
    currentUserInstance = this;
  });

  const AuthenticationDetails = vi.fn(function (this: any, data: { Username: string; Password: string }) {
    this.data = data;
  });

  const sdk = { CognitoUserPool, CognitoUser, AuthenticationDetails } as unknown as CognitoSdk;
  return { sdk, captured };
}

const sessionStorageMock = {} as Storage;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

function makeClient(overrides: {
  sdk?: CognitoSdk;
  storage?: Storage | (() => Storage | undefined);
  errorMapper?: (err: unknown) => Error;
  navigate?: (url: string) => void;
  getCurrentPath?: () => string;
} = {}) {
  return new CognitoClient({
    userPoolId: 'ca-central-1_TEST',
    clientId: 'test-client',
    sdk: overrides.sdk ?? ({} as CognitoSdk),
    storage: overrides.storage ?? sessionStorageMock,
    errorMapper: overrides.errorMapper ?? ((err: unknown) => new Error(String((err as any)?.code ?? 'Unknown'))),
    navigate: overrides.navigate ?? vi.fn(),
    getCurrentPath: overrides.getCurrentPath,
  });
}

describe('CognitoClient — dependency injection', () => {
  it('constructs the pool with the supplied pool config and sessionStorage', () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk });
    void client.signUp('test@example.com', 'Pass123!');
    expect(captured.pools).toHaveLength(1);
    expect(captured.pools[0].UserPoolId).toBe('ca-central-1_TEST');
    expect(captured.pools[0].ClientId).toBe('test-client');
    expect(captured.pools[0].Storage).toBe(sessionStorageMock);
  });

  it('resolves lazy pool-config suppliers at initPool time, not construction', async () => {
    const { sdk, captured } = installMockSdk({});
    let poolId = 'ca-central-1_PLACEHOLDER';
    let clientId = 'PLACEHOLDER_CLIENT_ID';
    const client = new CognitoClient({
      userPoolId: () => poolId,
      clientId: () => clientId,
      sdk,
      storage: sessionStorageMock,
      errorMapper: (err: unknown) => new Error(String((err as any)?.code ?? 'Unknown')),
      navigate: vi.fn(),
    });
    // Simulate a product whose config is not yet available at import time.
    poolId = 'ca-central-1_RealPool';
    clientId = 'real-client-id';
    await client.getSession();
    expect(captured.pools).toHaveLength(1);
    expect(captured.pools[0].UserPoolId).toBe('ca-central-1_RealPool');
    expect(captured.pools[0].ClientId).toBe('real-client-id');
  });

  it('creates every CognitoUser with the supplied sessionStorage', async () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk });
    await client.signIn('test@example.com', 'Pass123!');
    await client.forgotPassword('test@example.com');
    expect(captured.users).toHaveLength(2);
    for (const user of captured.users) {
      expect(user.Storage).toBe(sessionStorageMock);
    }
  });

  it('fails closed when the storage hook returns undefined in a browser env', () => {
    // jsdom exposes localStorage, so a missing storage hook would make the
    // Cognito SDK silently persist the refresh token there — the guard turns
    // that silent fallback into an explicit error.
    const { sdk } = installMockSdk({});
    const client = makeClient({ sdk, storage: () => undefined });
    expect(() => client.signUp('test@example.com', 'Pass123!')).toThrow(
      /no Storage supplied.*localStorage/,
    );
  });

  it('routes SDK errors through the injected errorMapper', async () => {
    const { sdk } = installMockSdk({
      authenticateUser: (callbacks) => callbacks.onFailure({ code: 'NotAuthorizedException' }),
    });
    const mapper = vi.fn(() => new Error('mapped error'));
    const client = makeClient({ sdk, errorMapper: mapper });
    await expect(client.signIn('test@example.com', 'wrong')).rejects.toThrow('mapped error');
    expect(mapper).toHaveBeenCalledWith(expect.objectContaining({ code: 'NotAuthorizedException' }));
  });

  it('allows an omitted storage hook in a non-browser runtime', () => {
    // Without a `localStorage` global the SDK has nowhere to fall back to, so an
    // undefined storage hook is legitimate and no Storage option is passed.
    const { sdk, captured } = installMockSdk({});
    vi.stubGlobal('localStorage', undefined);
    try {
      const client = makeClient({ sdk, storage: () => undefined });
      expect(() => client.signUp('test@example.com', 'Pass123!')).not.toThrow();
      expect(captured.pools).toHaveLength(1);
      expect(captured.pools[0].Storage).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['signIn', (client: CognitoClient) => client.signIn('test@example.com', 'Pass123!')],
    ['confirmSignUp', (client: CognitoClient) => client.confirmSignUp('test@example.com', '123456')],
    ['forgotPassword', (client: CognitoClient) => client.forgotPassword('test@example.com')],
    [
      'confirmNewPassword',
      (client: CognitoClient) => client.confirmNewPassword('test@example.com', '123456', 'NewPass123!'),
    ],
  ])('%s initializes the pool and shares it with its CognitoUser', async (_name, invoke) => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk });
    await invoke(client);
    expect(captured.pools).toHaveLength(1);
    expect(captured.users).toHaveLength(1);
    expect(captured.users[0].Pool).toBe(captured.poolInstances[0]);
  });
});

describe('CognitoClient — signIn / session', () => {
  it('stores tokens in memory only and persists the session via setSignInUserSession', async () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk });
    const result = await client.signIn('test@example.com', 'Pass123!');
    expect(result).toEqual({ challenge: null, idToken: 'mock-id-token', accessToken: 'mock-access-token' });
    expect(captured.setSignInUserSessionCalls).toHaveLength(1);
    expect(client.getIdToken()).toBe('mock-id-token');
    expect(client.getAccessToken()).toBe('mock-access-token');
    expect(client.getUser()).toBe('test@example.com');
    expect(localStorage.length).toBe(0);
  });

  it('resolves NEW_PASSWORD_REQUIRED as a challenge instead of throwing', async () => {
    const { sdk } = installMockSdk({
      authenticateUser: (callbacks) =>
        callbacks.newPasswordRequired({ sub: 'user-sub', email: 'test@example.com' }, {}),
    });
    const client = makeClient({ sdk });
    const result = await client.signIn('test@example.com', 'TempPass123!');
    expect(result.challenge).toBe('NEW_PASSWORD_REQUIRED');
    expect((result as any).userAttributes).toHaveProperty('email', 'test@example.com');
  });

  it('completes the NEW_PASSWORD_REQUIRED challenge, scrubbing `sub`, and persists the session', async () => {
    let sentAttrs: Record<string, unknown> | null = null;
    const { sdk, captured } = installMockSdk({
      authenticateUser: (callbacks) =>
        callbacks.newPasswordRequired({ sub: 'user-sub', email: 'test@example.com' }, {}),
      completeNewPasswordChallenge: (_pwd, attrs, callbacks) => {
        sentAttrs = attrs as Record<string, unknown>;
        callbacks.onSuccess(makeSession('challenge-id-token', 'challenge-access-token'));
      },
    });
    const client = makeClient({ sdk });
    const signInResult = await client.signIn('test@example.com', 'TempPass123!');
    expect(signInResult.challenge).toBe('NEW_PASSWORD_REQUIRED');

    const tokens = await client.completeNewPassword('NewPass123!', (signInResult as any).userAttributes);
    expect(tokens).toHaveProperty('idToken', 'challenge-id-token');
    expect(sentAttrs).not.toHaveProperty('sub');
    expect(sentAttrs).toHaveProperty('email', 'test@example.com');
    expect(captured.setSignInUserSessionCalls).toHaveLength(1);
    expect(client.getIdToken()).toBe('challenge-id-token');
  });

  it('rejects completeNewPassword when no challenge is pending', async () => {
    const { sdk } = installMockSdk({});
    const client = makeClient({ sdk });
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
  });

  it('clears the pending challenge when challenge completion fails', async () => {
    const { sdk } = installMockSdk({
      authenticateUser: (callbacks) => callbacks.newPasswordRequired({}, {}),
      completeNewPasswordChallenge: (_pwd, _attrs, callbacks) => callbacks.onFailure({ code: 'InvalidPasswordException' }),
    });
    const client = makeClient({ sdk });
    await client.signIn('test@example.com', 'TempPass123!');
    await expect(client.completeNewPassword('weak')).rejects.toThrow();
    // A second completion attempt must fail with "no pending challenge" —
    // the failed attempt cleared the in-flight challenge.
    await expect(client.completeNewPassword('weak')).rejects.toThrow(/No pending password challenge/);
  });

  it('restores a valid cached session via getSession', async () => {
    const { sdk } = installMockSdk({});
    const client = makeClient({ sdk });
    const session = await client.getSession();
    expect(session).toEqual({ idToken: 'restored-id-token', accessToken: 'restored-access-token', user: 'test@example.com' });
  });

  it('clears a stale session (invalid) via signOut and resolves null', async () => {
    const { sdk, captured } = installMockSdk({ invalidSession: true });
    const client = makeClient({ sdk });
    const session = await client.getSession();
    expect(session).toBeNull();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
  });

  it('refreshes tokens through the cached session', async () => {
    const { sdk } = installMockSdk({});
    const client = makeClient({ sdk });
    const tokens = await client.refreshSession();
    expect(tokens).toHaveProperty('idToken', 'restored-id-token');
    expect(tokens).toHaveProperty('accessToken', 'restored-access-token');
  });

  it('clears a stale session (invalid) via signOut on refresh failure', async () => {
    const { sdk, captured } = installMockSdk({ invalidSession: true });
    const client = makeClient({ sdk });
    await expect(client.refreshSession()).rejects.toThrow();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
  });

  it('rejects refreshSession when no cached user exists', async () => {
    const { sdk } = installMockSdk({ noCurrentUser: true });
    const client = makeClient({ sdk });
    await expect(client.refreshSession()).rejects.toThrow(/No cached session/);
  });
});

describe('CognitoClient — sign-out / navigation', () => {
  it('signOut clears in-memory tokens and calls the SDK signOut', async () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk });
    await client.signIn('test@example.com', 'Pass123!');
    client.signOut();
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    expect(client.getUser()).toBeNull();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
  });

  it('redirectToLogin builds a safe ?returnTo= target through the injected hooks', () => {
    const { sdk } = installMockSdk({});
    const navigate = vi.fn();
    const client = makeClient({
      sdk,
      navigate,
      getCurrentPath: () => '/dashboard.html?year=2026',
    });
    client.redirectToLogin('login.html');
    expect(navigate).toHaveBeenCalledWith('login.html?returnTo=' + encodeURIComponent('/dashboard.html?year=2026'));
  });

  it('redirectToLogin signs out the stale session first', async () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk, navigate: vi.fn() });
    await client.signIn('test@example.com', 'Pass123!');
    client.redirectToLogin('login.html');
    expect(client.getIdToken()).toBeNull();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('CognitoClient — ensureSession page-load gate', () => {
  it('resolves the live session without navigating', async () => {
    const { sdk } = installMockSdk({});
    const navigate = vi.fn();
    const client = makeClient({ sdk, navigate });
    const session = await client.ensureSession('/signin');
    expect(session).not.toBeNull();
    expect(session).toHaveProperty('idToken', 'restored-id-token');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('resolves null and redirects when no cached user exists', async () => {
    const { sdk } = installMockSdk({ noCurrentUser: true });
    const navigate = vi.fn();
    const client = makeClient({ sdk, navigate, getCurrentPath: () => '/portal' });
    await expect(client.ensureSession('/signin')).resolves.toBeNull();
    expect(navigate).toHaveBeenCalledWith('/signin?returnTo=' + encodeURIComponent('/portal'));
  });

  it('resolves null and redirects when the cached session is invalid', async () => {
    const { sdk } = installMockSdk({ invalidSession: true });
    const navigate = vi.fn();
    const client = makeClient({ sdk, navigate });
    await expect(client.ensureSession('/signin')).resolves.toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(client.getIdToken()).toBeNull();
  });

  it('never throws — SDK failures become null + redirect', async () => {
    const { sdk } = installMockSdk({
      getSession: () => {
        throw new Error('sdk exploded');
      },
    });
    const navigate = vi.fn();
    const client = makeClient({ sdk, navigate });
    await expect(client.ensureSession('/signin')).resolves.toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('never throws when the pool itself cannot be initialized', async () => {
    // A storage misconfiguration makes initPool() throw synchronously inside
    // getSession(); ensureSession() must swallow that too, redirect, and
    // resolve null rather than rejecting.
    const { sdk } = installMockSdk({});
    const navigate = vi.fn();
    const client = makeClient({
      sdk,
      navigate,
      storage: () => localStorage,
      getCurrentPath: () => '/portal',
    });
    await expect(client.ensureSession('/signin')).resolves.toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/signin?returnTo=' + encodeURIComponent('/portal'));
  });
});

describe('isTokenExpired — fail-closed JWT expiry probe', () => {
  function b64(payloadJson: string): string {
    return btoa(payloadJson).replace(/\+/g, '-').replace(/\//g, '_');
  }

  function jwt(exp: number | null): string {
    const payload: Record<string, unknown> = { sub: 'synthetic-subject' };
    if (exp !== null) payload.exp = exp;
    return `header.${b64(JSON.stringify(payload))}.signature`;
  }

  it('reports expired and valid tokens around the skew window', async () => {
    const { isTokenExpired } = await import('../src/index');
    const nowSec = Math.floor(Date.now() / 1000);
    expect(isTokenExpired(jwt(nowSec - 3600))).toBe(true);
    expect(isTokenExpired(jwt(nowSec + 3600))).toBe(false);
  });

  it('fails closed on malformed tokens and missing exp', async () => {
    const { isTokenExpired } = await import('../src/index');
    expect(isTokenExpired('not-a-jwt')).toBe(true);
    expect(isTokenExpired(jwt(null))).toBe(true);
    expect(isTokenExpired('')).toBe(true);
  });

  it('fails closed when the payload cannot be decoded or parsed', async () => {
    const { isTokenExpired } = await import('../src/index');
    // A two-part token reaches the decode step: a non-base64 payload, a base64
    // payload that is not JSON, and an empty payload must all fail closed.
    expect(isTokenExpired('header.@@@not-base64@@@')).toBe(true);
    expect(isTokenExpired(`header.${btoa('not json')}`)).toBe(true);
    expect(isTokenExpired('header.')).toBe(true);
  });

  it('judges a two-part token on its payload instead of rejecting it', async () => {
    const { isTokenExpired } = await import('../src/index');
    const nowSec = Math.floor(Date.now() / 1000);
    // `parts.length < 2` is the malformed guard — exactly two parts still carry
    // a payload at index 1, which must be parsed and evaluated.
    expect(isTokenExpired(`header.${b64(JSON.stringify({ exp: nowSec + 3600 }))}`)).toBe(false);
    expect(isTokenExpired(`header.${b64(JSON.stringify({ exp: nowSec - 3600 }))}`)).toBe(true);
  });

  it('fails closed on a non-finite exp claim', async () => {
    const { isTokenExpired } = await import('../src/index');
    // `JSON.parse` turns an overflowing numeric literal into Infinity: the type
    // is a number but the value is not finite, so the probe must fail closed.
    expect(isTokenExpired(`header.${b64('{"exp":1e999}')}.signature`)).toBe(true);
  });

  it('treats the inclusive skew boundary and the inside of the window as expired', async () => {
    const { isTokenExpired } = await import('../src/index');
    const expSec = 1_700_000_000;
    const expMs = expSec * 1000;
    // Exactly at the boundary (nowMs + 60s === exp) the token counts as expired.
    expect(isTokenExpired(jwt(expSec), expMs - 60_000)).toBe(true);
    // One millisecond later it is no longer inside the tolerated skew.
    expect(isTokenExpired(jwt(expSec), expMs - 60_001)).toBe(false);
    // Still live by 30s, but inside the skew: fail closed and treat as expired.
    expect(isTokenExpired(jwt(expSec), expMs - 30_000)).toBe(true);
  });
});

describe('CognitoClient — product neutrality', () => {
  it('exposes no product role derivation or route policy', () => {
    const { sdk } = installMockSdk({});
    const client = makeClient({ sdk });
    const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
    expect(proto).not.toHaveProperty('role');
    expect(proto).not.toHaveProperty('requireAuth');
    // redirectToLogin exists on the core but takes the login URL as a required
    // argument — the route itself is product policy supplied by the adapter.
    expect(typeof proto.redirectToLogin).toBe('function');
  });

  it('does not embed product terms (roles, routes, copy) in the core source', () => {
    expect(CognitoClient.toString()).not.toMatch(
      /login\.html|onboarding|staff|owner|manager|tenant|myapp|yourapp|help@/,
    );
  });
});

describe('CognitoClient — SDK error and edge-case behavior', () => {
  it('confirmSignUp rejects when the SDK returns an error', async () => {
    const { sdk } = installMockSdk({
      // Override the default success callback with an error.
      // We re-implement confirmRegistration so it calls back with an error.
    });
    // Reaching into the mock to change the confirmRegistration callback is
    // awkward; instead create a custom SDK mock for this one test.
    const CognitoUser = vi.fn(function (this: any, data: any) {
      this.Username = data.Username;
      this.Pool = data.Pool;
      this.confirmRegistration = vi.fn((_code: string, _force: boolean, cb: (err: unknown) => void) =>
        cb({ code: 'CodeMismatchException' })
      );
    });
    const CognitoUserPool = vi.fn(function (this: any, data: any) {
      this.data = data;
      this.getCurrentUser = vi.fn(() => null);
    });
    const customSdk = { CognitoUserPool, CognitoUser, AuthenticationDetails: vi.fn() } as unknown as CognitoSdk;
    const client = makeClient({ sdk: customSdk });
    await expect(client.confirmSignUp('test@example.com', '123456')).rejects.toThrow('CodeMismatchException');
  });

  it('getSession resolves null when there is no current user', async () => {
    const { sdk } = installMockSdk({ noCurrentUser: true });
    const client = makeClient({ sdk });
    const session = await client.getSession();
    expect(session).toBeNull();
  });

  it('getSession clears stale session when getSession returns an error but a valid session', async () => {
    const { sdk, captured } = installMockSdk({
      getSession: (cb) => cb({ code: 'NotAuthorizedException' }, makeSession('err-id', 'err-access')),
    });
    const client = makeClient({ sdk });
    const session = await client.getSession();
    expect(session).toBeNull();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
  });

  it('refreshSession rejects when getSession returns an error but a valid session', async () => {
    const { sdk } = installMockSdk({
      getSession: (cb) => cb({ code: 'NotAuthorizedException' }, makeSession('err-id', 'err-access')),
    });
    const client = makeClient({ sdk });
    await expect(client.refreshSession()).rejects.toThrow('NotAuthorizedException');
  });

  it('forgotPassword resolves when the SDK uses the inputVerificationCode callback', async () => {
    const CognitoUser = vi.fn(function (this: any, data: any) {
      this.Username = data.Username;
      this.Pool = data.Pool;
      this.forgotPassword = vi.fn(({ inputVerificationCode }: any) => inputVerificationCode());
    });
    const CognitoUserPool = vi.fn(function (this: any) {
      this.getCurrentUser = vi.fn(() => null);
    });
    const customSdk = { CognitoUserPool, CognitoUser, AuthenticationDetails: vi.fn() } as unknown as CognitoSdk;
    const client = makeClient({ sdk: customSdk });
    await expect(client.forgotPassword('test@example.com')).resolves.toBeUndefined();
  });

  it('signOut does not throw when there is no current user', () => {
    const { sdk } = installMockSdk({ noCurrentUser: true });
    const client = makeClient({ sdk });
    void client.signIn('test@example.com', 'Pass123!');
    client.signOut();
    expect(client.getIdToken()).toBeNull();
  });

  it('getSession clears tokens when getSession throws synchronously', async () => {
    const { sdk } = installMockSdk({
      getSession: () => {
        throw new Error('synchronous throw');
      },
    });
    const client = makeClient({ sdk });
    void client.signIn('test@example.com', 'Pass123!');
    const session = await client.getSession();
    expect(session).toBeNull();
    expect(client.getIdToken()).toBeNull();
  });

  it('getSession signs out the SDK user when getSession throws synchronously', async () => {
    const { sdk, captured } = installMockSdk({
      getSession: () => {
        throw new Error('synchronous throw');
      },
    });
    const client = makeClient({ sdk });
    await client.signIn('test@example.com', 'Pass123!');
    const session = await client.getSession();
    expect(session).toBeNull();
    expect(captured.signOutCalls).toBeGreaterThanOrEqual(1);
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    expect(client.getUser()).toBeNull();
  });
});

describe('CognitoClient — fail-closed auth state across signIn attempts', () => {
  function makeSequencedSdk(authSequence: Array<(callbacks: any) => void>) {
    const completedUsers: string[] = [];
    let calls = 0;
    const CognitoUserPool = vi.fn(function (this: any, data: ConstructedPoolArgs) {
      this.data = data;
      this.getCurrentUser = vi.fn(() => null);
    });
    const CognitoUser = vi.fn(function (this: any, data: ConstructedUserArgs) {
      const username = data.Username;
      this.getUsername = () => username;
      this.setSignInUserSession = vi.fn();
      this.signOut = vi.fn();
      this.authenticateUser = vi.fn((_details: unknown, callbacks: any) => {
        const step = authSequence[Math.min(calls, authSequence.length - 1)];
        calls++;
        step(callbacks);
      });
      this.completeNewPasswordChallenge = vi.fn(
        (_pwd: string, _attrs: unknown, callbacks: any) => {
          completedUsers.push(username);
          callbacks.onSuccess(makeSession(`${username}-id`, `${username}-access`));
        },
      );
    });
    const AuthenticationDetails = vi.fn(function (this: any, data: { Username: string; Password: string }) {
      this.data = data;
    });
    const sdk = { CognitoUserPool, CognitoUser, AuthenticationDetails } as unknown as CognitoSdk;
    return { sdk, completedUsers };
  }

  it('second signIn while a challenge is pending leaves only the second attempt pending', async () => {
    const { sdk, completedUsers } = makeSequencedSdk([
      (callbacks) => callbacks.newPasswordRequired({ attempt: 'first' }, {}),
      (callbacks) => callbacks.newPasswordRequired({ attempt: 'second' }, {}),
    ]);
    const client = makeClient({ sdk });
    const first = await client.signIn('first@example.com', 'TempPass1!');
    expect(first.challenge).toBe('NEW_PASSWORD_REQUIRED');
    const second = await client.signIn('second@example.com', 'TempPass2!');
    expect(second.challenge).toBe('NEW_PASSWORD_REQUIRED');
    // Completing must finish the second attempt's challenge only.
    const tokens = await client.completeNewPassword('NewPass123!');
    expect(completedUsers).toEqual(['second@example.com']);
    expect(tokens).toEqual({ idToken: 'second@example.com-id', accessToken: 'second@example.com-access' });
    // Challenge is consumed — no stale challenge remains.
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
  });

  it('failed signIn clears prior tokens and the pending challenge with the mapped error', async () => {
    const { sdk } = makeSequencedSdk([
      (callbacks) => callbacks.onSuccess(makeSession('prior-id', 'prior-access')),
      (callbacks) => callbacks.onFailure({ code: 'NotAuthorizedException' }),
    ]);
    const mapped = new Error('mapped failure');
    const mapper = vi.fn(() => mapped);
    const client = makeClient({ sdk, errorMapper: mapper });
    await client.signIn('prior@example.com', 'Pass123!');
    expect(client.getUser()).toBe('prior@example.com');
    await expect(client.signIn('prior@example.com', 'wrong')).rejects.toBe(mapped);
    expect(mapper).toHaveBeenCalledWith(expect.objectContaining({ code: 'NotAuthorizedException' }));
    expect(client.getUser()).toBeNull();
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
  });

  it('failed signIn after a pending challenge clears the stale challenge', async () => {
    const { sdk } = makeSequencedSdk([
      (callbacks) => callbacks.newPasswordRequired({ attempt: 'first' }, {}),
      (callbacks) => callbacks.onFailure({ code: 'NotAuthorizedException' }),
    ]);
    const client = makeClient({ sdk });
    const first = await client.signIn('first@example.com', 'TempPass1!');
    expect(first.challenge).toBe('NEW_PASSWORD_REQUIRED');
    await expect(client.signIn('second@example.com', 'wrong')).rejects.toThrow('NotAuthorizedException');
    expect(client.getUser()).toBeNull();
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
  });

  it('a stale failed attempt clears tokens set by a later successful attempt', async () => {
    let staleCallbacks: any = null;
    const { sdk } = makeSequencedSdk([
      (callbacks) => {
        staleCallbacks = callbacks; // the first attempt stays in flight
      },
      (callbacks) => callbacks.onSuccess(makeSession('second-id', 'second-access')),
    ]);
    const client = makeClient({ sdk });
    const stale = client.signIn('first@example.com', 'Pass123!');
    const second = await client.signIn('second@example.com', 'Pass123!');
    expect(second).toEqual({ challenge: null, idToken: 'second-id', accessToken: 'second-access' });
    expect(client.getUser()).toBe('second@example.com');
    // The stale attempt now fails: fail-closed, the onFailure reset must clear
    // the later attempt's tokens too — no authenticated state may survive any
    // auth failure (kills the `this.clearTokens()` removal mutant in onFailure).
    staleCallbacks.onFailure({ code: 'NotAuthorizedException' });
    await expect(stale).rejects.toThrow('NotAuthorizedException');
    expect(client.getUser()).toBeNull();
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
  });

  it('successful signIn clears a prior pending challenge', async () => {
    const { sdk, completedUsers } = makeSequencedSdk([
      (callbacks) => callbacks.newPasswordRequired({ attempt: 'first' }, {}),
      (callbacks) => callbacks.onSuccess(makeSession('second-id', 'second-access')),
    ]);
    const client = makeClient({ sdk });
    await client.signIn('first@example.com', 'TempPass1!');
    const result = await client.signIn('second@example.com', 'Pass123!');
    expect(result).toEqual({ challenge: null, idToken: 'second-id', accessToken: 'second-access' });
    expect(client.getUser()).toBe('second@example.com');
    // The first attempt's challenge must be gone — completing now throws.
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(/No pending password challenge/);
    expect(completedUsers).toEqual([]);
  });

  it('a new attempt clears prior tokens before the SDK responds', async () => {
    const { sdk } = makeSequencedSdk([
      (callbacks) => callbacks.onSuccess(makeSession('prior-id', 'prior-access')),
      () => {}, // the second attempt never calls back
    ]);
    const client = makeClient({ sdk });
    await client.signIn('prior@example.com', 'Pass123!');
    expect(client.getIdToken()).toBe('prior-id');
    void client.signIn('second@example.com', 'Pass123!');
    // The fail-closed reset runs before authenticateUser, so it applies even
    // while the SDK is still working on the new attempt.
    expect(client.getIdToken()).toBeNull();
    expect(client.getAccessToken()).toBeNull();
    expect(client.getUser()).toBeNull();
  });

  it('a new attempt clears a prior pending challenge before the SDK responds', async () => {
    const { sdk } = makeSequencedSdk([
      (callbacks) => callbacks.newPasswordRequired({ attempt: 'first' }, {}),
      () => {}, // the second attempt never calls back
    ]);
    const client = makeClient({ sdk });
    const first = await client.signIn('first@example.com', 'TempPass1!');
    expect(first.challenge).toBe('NEW_PASSWORD_REQUIRED');
    void client.signIn('second@example.com', 'TempPass1!');
    // The first attempt's challenge must already be invalidated.
    await expect(client.completeNewPassword('NewPass123!')).rejects.toThrow(
      /No pending password challenge/,
    );
  });
});
