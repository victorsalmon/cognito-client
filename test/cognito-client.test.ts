import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitoClient, type CognitoSdk } from '../src/index';

// ─── Minimal in-memory SDK mock ──────────────────────────────────────────────
// Unlike the façade tests (cognito.test.ts) which stub the global
// AmazonCognitoIdentity, these tests inject the mock SDK directly through the
// constructor. This is the whole point of the generic core: every dependency
// (SDK, storage, error mapper, navigation) arrives through the options.

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
  const captured: { pools: ConstructedPoolArgs[]; users: ConstructedUserArgs[]; setSignInUserSessionCalls: unknown[]; signOutCalls: number } = {
    pools: [],
    users: [],
    setSignInUserSessionCalls: [],
    signOutCalls: 0,
  };

  let currentUserInstance: any = null;

  const CognitoUserPool = vi.fn(function (this: any, data: ConstructedPoolArgs) {
    captured.pools.push(data);
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
    client.signUp('test@example.com', 'Pass123!');
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

  it('omits Storage when the storage hook returns undefined', () => {
    const { sdk, captured } = installMockSdk({});
    const client = makeClient({ sdk, storage: () => undefined });
    client.signUp('test@example.com', 'Pass123!');
    expect(captured.pools[0]).not.toHaveProperty('Storage');
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

describe('CognitoClient – final mutation-killing tests', () => {
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
    client.signIn('test@example.com', 'Pass123!');
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
    client.signIn('test@example.com', 'Pass123!');
    const session = await client.getSession();
    expect(session).toBeNull();
    expect(client.getIdToken()).toBeNull();
  });
});
