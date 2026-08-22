import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { CognitoClient, type CognitoSdk } from '../src/index';

/**
 * Property tests for the generic CognitoClient core.
 *
 * The client is stateful and async, so each property builds a fresh in-memory
 * SDK mock and asserts an invariant over randomly generated inputs. The
 * properties target the product-neutral contract: token state invariants,
 * the NEW_PASSWORD_REQUIRED `sub`-scrubbing rule, error-mapper routing, lazy
 * pool-config resolution, Storage injection, and the redirectToLogin URL
 * contract.
 */

interface Captured {
  pools: Array<{ UserPoolId: string; ClientId: string; Storage?: Storage }>;
  users: Array<{ Username: string; Storage?: Storage }>;
  completeAttrs: Record<string, unknown>[];
  setSessionCalls: unknown[];
  poolInstance: any;
  userInstances: any[];
  authDetailsInstances: any[];
}

function makeMockSdk(opts: {
  idToken?: string;
  accessToken?: string;
  challenge?: boolean;
  failure?: unknown;
} = {}): { sdk: CognitoSdk; captured: Captured } {
  const idToken = opts.idToken ?? 'id';
  const accessToken = opts.accessToken ?? 'access';
  const captured: Captured = {
    pools: [],
    users: [],
    completeAttrs: [],
    setSessionCalls: [],
    poolInstance: null,
    userInstances: [],
    authDetailsInstances: [],
  };

  const session = {
    isValid: () => true,
    getIdToken: () => ({ getJwtToken: () => idToken }),
    getAccessToken: () => ({ getJwtToken: () => accessToken }),
    getRefreshToken: () => ({ getToken: () => 'refresh' }),
  };

  let current: any = null;
  const CognitoUserPool = vi.fn(function (this: any, data: any) {
    captured.pools.push(data);
    this.signUp = vi.fn((_e: string, _p: string, _a: unknown, _v: unknown, cb: any) =>
      cb(null, { userConfirmed: true, userSub: 'sub-1' }),
    );
    this.getCurrentUser = vi.fn(() => current);
    captured.poolInstance = this;
  });
  const CognitoUser = vi.fn(function (this: any, data: any) {
    captured.users.push(data);
    this.getUsername = () => data.Username;
    this.setSignInUserSession = vi.fn((s: unknown) => captured.setSessionCalls.push(s));
    this.signOut = vi.fn();
    this.authenticateUser = vi.fn((_d: unknown, cb: any) => {
      if (opts.failure !== undefined) return cb.onFailure(opts.failure);
      if (opts.challenge) return cb.newPasswordRequired({ sub: 's', email: data.Username }, {});
      cb.onSuccess(session);
    });
    this.getSession = vi.fn((cb: any) => cb(null, session));
    this.confirmRegistration = vi.fn((_c: string, _f: boolean, cb: any) => cb(null, 'SUCCESS'));
    this.forgotPassword = vi.fn(({ onSuccess }: any) => onSuccess());
    this.confirmPassword = vi.fn((_c: string, _p: string, { onSuccess }: any) => onSuccess());
    this.completeNewPasswordChallenge = vi.fn((_pwd: string, attrs: Record<string, unknown>, cb: any) => {
      captured.completeAttrs.push(attrs);
      cb.onSuccess(session);
    });
    current = this;
    captured.userInstances.push(this);
  });
  const AuthenticationDetails = vi.fn(function (this: any, data: any) {
    this.data = data;
    captured.authDetailsInstances.push(this);
  });
  return {
    sdk: { CognitoUserPool, CognitoUser, AuthenticationDetails } as unknown as CognitoSdk,
    captured,
  };
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
    errorMapper:
      overrides.errorMapper ?? ((err: unknown) => new Error(String((err as any)?.code ?? 'Unknown'))),
    navigate: overrides.navigate ?? vi.fn(),
    getCurrentPath: overrides.getCurrentPath,
  });
}

const emailArb = fc.integer({ min: 1, max: 9999 }).map((n) => `user${n}@example.com`);
const tokenArb = fc.string({ minLength: 1, maxLength: 24 });

describe('CognitoClient — property tests', () => {
  it('redirectToLogin: encodes any non-empty currentPath as ?returnTo=, else navigates to the bare loginUrl', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }),
        fc.string({ maxLength: 24 }),
        (loginUrl, currentPath) => {
          const navigate = vi.fn();
          const client = makeClient({
            navigate,
            getCurrentPath: () => currentPath,
          });
          client.redirectToLogin(loginUrl);
          const target = navigate.mock.calls[0][0] as string;
          if (currentPath.length > 0) {
            expect(target).toBe(`${loginUrl}?returnTo=${encodeURIComponent(currentPath)}`);
          } else {
            expect(target).toBe(loginUrl);
          }
        },
      ),
    );
  });

  it('redirectToLogin: navigates to the bare loginUrl (no ?returnTo=) when getCurrentPath is not provided', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), (loginUrl) => {
        const navigate = vi.fn();
        const client = makeClient({ navigate });
        client.redirectToLogin(loginUrl);
        expect(navigate).toHaveBeenCalledWith(loginUrl);
      }),
    );
  });

  it('redirectToLogin: signs out first, leaving no tokens behind for any prior state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), emailArb, async (signedIn, email) => {
        const { sdk } = makeMockSdk({});
        const client = makeClient({ sdk, navigate: vi.fn() });
        if (signedIn) await client.signIn(email, 'Pass123!');
        client.redirectToLogin('login.html');
        expect(client.getIdToken()).toBeNull();
        expect(client.getAccessToken()).toBeNull();
        expect(client.getUser()).toBeNull();
      }),
    );
  });

  it('completeNewPassword: scrubs `sub` and passes every other attribute through unchanged', async () => {
    const otherKeyArb = fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => s !== 'sub' && s.length > 0);
    const valueArb = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    );
    const attrsArb = fc.dictionary(otherKeyArb, valueArb);
    const withSubArb = fc.record({
      attrs: attrsArb,
      subValue: fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()),
    });
    await fc.assert(
      fc.asyncProperty(withSubArb, async ({ attrs, subValue }) => {
        const { sdk, captured } = makeMockSdk({ challenge: true });
        const client = makeClient({ sdk });
        await client.signIn('u@example.com', 'TempPass123!');
        await client.completeNewPassword('NewPass123!', { ...attrs, sub: subValue });
        const sent = captured.completeAttrs[captured.completeAttrs.length - 1];
        expect(sent).not.toHaveProperty('sub');
        for (const [k, v] of Object.entries(attrs)) {
          expect(sent[k]).toStrictEqual(v);
        }
      }),
    );
  });

  it('signOut: always clears idToken, accessToken, and user regardless of prior state', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), emailArb, async (signedIn, email) => {
        const { sdk } = makeMockSdk({});
        const client = makeClient({ sdk });
        if (signedIn) await client.signIn(email, 'Pass123!');
        client.signOut();
        expect(client.getIdToken()).toBeNull();
        expect(client.getAccessToken()).toBeNull();
        expect(client.getUser()).toBeNull();
      }),
    );
  });

  it('signIn failure: routes every SDK error through the injected errorMapper', async () => {
    const errArb = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.integer(),
      fc.record({ code: fc.string({ maxLength: 8 }) }),
      fc.constant(null),
    );
    await fc.assert(
      fc.asyncProperty(errArb, async (err) => {
        const { sdk } = makeMockSdk({ failure: err });
        const mapped = new Error('MAPPED');
        const mapper = vi.fn(() => mapped);
        const client = makeClient({ sdk, errorMapper: mapper });
        await expect(client.signIn('u@example.com', 'p')).rejects.toBe(mapped);
        expect(mapper).toHaveBeenCalledWith(err);
      }),
    );
  });

  it('signIn success: stores the session tokens and username in memory', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, tokenArb, tokenArb, async (email, idToken, accessToken) => {
        const { sdk, captured } = makeMockSdk({ idToken, accessToken });
        const client = makeClient({ sdk });
        const result = await client.signIn(email, 'Pass123!');
        expect(result).toEqual({ challenge: null, idToken, accessToken });
        expect(client.getIdToken()).toBe(idToken);
        expect(client.getAccessToken()).toBe(accessToken);
        expect(client.getUser()).toBe(email);
        // The session is persisted to the SDK storage for post-redirect restore.
        expect(captured.setSessionCalls).toHaveLength(1);
      }),
    );
  });

  it('lazy pool config: resolves suppliers at initPool time with their current values', async () => {
    const idArb = fc.string({ minLength: 1, maxLength: 16 }).map((s) => s.replace(/\s/g, '_'));
    await fc.assert(
      fc.asyncProperty(idArb, idArb, async (poolId, clientId) => {
        const { sdk, captured } = makeMockSdk({});
        let currentPool = poolId;
        let currentClient = clientId;
        const client = new CognitoClient({
          userPoolId: () => currentPool,
          clientId: () => currentClient,
          sdk,
          storage: () => undefined,
          errorMapper: (err) => new Error(String(err)),
          navigate: vi.fn(),
        });
        await client.getSession();
        expect(captured.pools[0].UserPoolId).toBe(poolId);
        expect(captured.pools[0].ClientId).toBe(clientId);
      }),
    );
  });

  it('Storage injection: passes the injected Storage to every pool/user, or omits it when undefined', async () => {
    const storageArb = fc.oneof(
      fc.constant(undefined),
      fc.constant({} as Storage),
      fc.constant(sessionStorageMock),
    );
    await fc.assert(
      fc.asyncProperty(storageArb, async (storage) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk, storage: () => storage });
        await client.signIn('u@example.com', 'Pass123!');
        await client.forgotPassword('u@example.com');
        for (const pool of captured.pools) {
          if (storage) expect(pool.Storage).toBe(storage);
          else expect(pool).not.toHaveProperty('Storage');
        }
        for (const user of captured.users) {
          if (storage) expect(user.Storage).toBe(storage);
          else expect(user).not.toHaveProperty('Storage');
        }
      }),
    );
  });

  it('getSession: restores idToken, accessToken, and user from a valid cached session', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, tokenArb, tokenArb, async (email, idToken, accessToken) => {
        const { sdk } = makeMockSdk({ idToken, accessToken });
        const client = makeClient({ sdk });
        await client.signIn(email, 'Pass123!');
        const restored = await client.getSession();
        expect(restored).toEqual({ idToken, accessToken, user: email });
        expect(client.getIdToken()).toBe(idToken);
        expect(client.getUser()).toBe(email);
      }),
    );
  });

  it('initPool: creates the pool exactly once across many auth operations (idempotent)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (ops) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        for (let i = 0; i < ops; i++) await client.getSession();
        expect(captured.pools).toHaveLength(1);
      }),
    );
  });

  it('signUp: passes email/password/attributes through; maps SDK errors; defaults attributeList to []', async () => {
    const attrsArb = fc.array(
      fc.record({ Name: fc.string({ minLength: 1, maxLength: 8 }), Value: fc.string({ maxLength: 8 }) }),
      { maxLength: 5 },
    );
    await fc.assert(
      fc.asyncProperty(emailArb, fc.string({ minLength: 1, maxLength: 16 }), attrsArb, async (email, password, attrs) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        const result = await client.signUp(email, password, attrs);
        expect(result).toEqual({ userConfirmed: true, userSub: 'sub-1' });
        const signUpArgs = captured.poolInstance.signUp.mock.calls[0];
        expect(signUpArgs[0]).toBe(email);
        expect(signUpArgs[1]).toBe(password);
        expect(signUpArgs[2]).toEqual(attrs);
        expect(signUpArgs[3]).toBeNull();
      }),
    );
    // Default attributeList is [].
    const { sdk, captured } = makeMockSdk({});
    const client = makeClient({ sdk });
    await client.signUp('u@example.com', 'p');
    expect(captured.poolInstance.signUp.mock.calls[0][2]).toEqual([]);
  });

  it('signUp: routes SDK errors through errorMapper', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 8 }), async (errCode) => {
        const { sdk, captured } = makeMockSdk({});
        const mapped = new Error('MAPPED');
        const client = makeClient({ sdk, errorMapper: () => mapped });
        // Initialize the pool by calling getSession first (no cached user → null).
        await client.getSession();
        // Now override signUp to call back with an error.
        captured.poolInstance.signUp = vi.fn((_e: string, _p: string, _a: unknown, _v: unknown, cb: any) => cb(new Error(errCode), null));
        await expect(client.signUp('u@example.com', 'p')).rejects.toBe(mapped);
      }),
    );
  });

  it('confirmSignUp: calls confirmRegistration(code, true, cb) and maps errors', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, fc.string({ minLength: 1, maxLength: 8 }), async (email, code) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        await client.confirmSignUp(email, code);
        const user = captured.users[captured.users.length - 1];
        expect(user.Username).toBe(email);
      }),
    );
  });

  it('forgotPassword: resolves on onSuccess or inputVerificationCode; maps errors', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, async (email) => {
        const { sdk } = makeMockSdk({});
        const client = makeClient({ sdk });
        await expect(client.forgotPassword(email)).resolves.toBeUndefined();
      }),
    );
  });

  it('confirmNewPassword: calls confirmPassword(code, newPassword, cb) and maps errors', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 16 }), async (email, code, newPassword) => {
        const { sdk } = makeMockSdk({});
        const client = makeClient({ sdk });
        await expect(client.confirmNewPassword(email, code, newPassword)).resolves.toBeUndefined();
      }),
    );
  });

  it('getSession: returns null when no current user is cached', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (signedInBefore) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        // Always signIn first to initialize the pool (so poolInstance exists).
        await client.signIn('u@example.com', 'Pass123!');
        if (!signedInBefore) client.signOut();
        // Force getCurrentUser to return null (no cached user).
        captured.poolInstance.getCurrentUser = vi.fn(() => null);
        const result = await client.getSession();
        expect(result).toBeNull();
      }),
    );
  });

  it('getSession: returns null and clears tokens when the cached session is invalid', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (signedInBefore) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        await client.signIn('u@example.com', 'Pass123!');
        if (!signedInBefore) client.signOut();
        // Make getSession return an invalid session on the last user instance.
        const userInstance = captured.userInstances[captured.userInstances.length - 1];
        userInstance.getSession = vi.fn((cb: any) => cb(null, { isValid: () => false }));
        const result = await client.getSession();
        expect(result).toBeNull();
        expect(client.getIdToken()).toBeNull();
      }),
    );
  });

  it('getSession: returns null and clears tokens when getSession yields an error', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (signedInBefore) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        await client.signIn('u@example.com', 'Pass123!');
        if (!signedInBefore) client.signOut();
        const userInstance = captured.userInstances[captured.userInstances.length - 1];
        userInstance.getSession = vi.fn((cb: any) => cb(new Error('expired'), null));
        const result = await client.getSession();
        expect(result).toBeNull();
        expect(client.getIdToken()).toBeNull();
      }),
    );
  });

  it('refreshSession: rejects with "No cached session" when no current user', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (signedInBefore) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        await client.signIn('u@example.com', 'Pass123!');
        if (!signedInBefore) client.signOut();
        captured.poolInstance.getCurrentUser = vi.fn(() => null);
        await expect(client.refreshSession()).rejects.toThrow(/No cached session/);
      }),
    );
  });

  it('refreshSession: rejects with mapped error or "No valid cached session" when session invalid', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (withError) => {
        const { sdk, captured } = makeMockSdk({});
        const mapped = new Error('MAPPED');
        const client = makeClient({ sdk, errorMapper: () => mapped });
        await client.signIn('u@example.com', 'Pass123!');
        const userInstance = captured.userInstances[captured.userInstances.length - 1];
        if (withError) {
          userInstance.getSession = vi.fn((cb: any) => cb(new Error('expired'), null));
          await expect(client.refreshSession()).rejects.toBe(mapped);
        } else {
          userInstance.getSession = vi.fn((cb: any) => cb(null, { isValid: () => false }));
          await expect(client.refreshSession()).rejects.toThrow(/No valid cached session/);
        }
      }),
    );
  });

  it('signIn: constructs AuthenticationDetails with Username/Password', async () => {
    await fc.assert(
      fc.asyncProperty(emailArb, fc.string({ minLength: 1, maxLength: 16 }), async (email, password) => {
        const { sdk, captured } = makeMockSdk({});
        const client = makeClient({ sdk });
        await client.signIn(email, password);
        expect(captured.authDetailsInstances[0].data).toEqual({ Username: email, Password: password });
      }),
    );
  });
});
