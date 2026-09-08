/**
 * Offline quickstart — consumer wiring example (no network calls).
 *
 * Mirrors the README post-login `resolveReturnTo` helper shape and the
 * canonical validation rules in docs/plan-evidence.md (same-origin path only:
 * must start with `/`, must not start with `//`, must not contain `\`,
 * rejects control chars and scheme/absolute URLs with `:` before any `/?#`,
 * decode-safe, fail-closed to `/`).
 */
import { CognitoClient, type CognitoSdk } from '../src/index';

// --- In-memory Storage stub (tab-scoped semantics like sessionStorage) ---
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const memoryStorage = new MemoryStorage();

// --- Minimal offline SDK stub (no network) ---
function makeFakeSession(idToken: string, accessToken: string) {
  return {
    isValid: () => true,
    getIdToken: () => ({ getJwtToken: () => idToken }),
    getAccessToken: () => ({ getJwtToken: () => accessToken }),
    getRefreshToken: () => ({ getToken: () => 'fake-refresh-token' }),
  };
}

class FakeCognitoUser {
  private username: string;

  constructor(data: { Username: string; Pool: unknown; Storage?: Storage }) {
    this.username = data.Username;
  }

  authenticateUser(
    _details: unknown,
    callbacks: {
      onSuccess: (session: never, userConfirmationNecessary?: boolean) => void;
      onFailure: (err: unknown) => void;
    },
  ): void {
    callbacks.onSuccess(
      makeFakeSession('fake-id-token', 'fake-access-token') as never,
    );
  }

  getSession(callback: (err: unknown, session: unknown) => void): void {
    callback(null, makeFakeSession('restored-id-token', 'restored-access-token'));
  }

  confirmRegistration(
    _code: string,
    _forceAliasCreation: boolean,
    callback: (err: unknown, result: unknown) => void,
  ): void {
    callback(null, 'SUCCESS');
  }

  forgotPassword(callbacks: {
    onSuccess: () => void;
    onFailure: (err: unknown) => void;
    inputVerificationCode: (data?: unknown) => void;
  }): void {
    callbacks.onSuccess();
  }

  confirmPassword(
    _code: string,
    _newPassword: string,
    callbacks: { onSuccess: () => void; onFailure: (err: unknown) => void },
  ): void {
    callbacks.onSuccess();
  }

  signOut(): void {
    // no-op offline
  }

  getUsername(): string {
    return this.username;
  }

  setSignInUserSession(_session: unknown): void {
    // no-op offline
  }
}

class FakeCognitoUserPool {
  constructor(_data: { UserPoolId: string; ClientId: string; Storage?: Storage }) {
    // offline — captures nothing
  }

  signUp(
    _username: string,
    _password: string,
    _attributeList: Array<{ Name: string; Value: string }>,
    _validationData: unknown[] | null,
    callback: (
      err: unknown,
      result: { userConfirmed: boolean; userSub: string } | null,
    ) => void,
  ): void {
    callback(null, { userConfirmed: false, userSub: 'sub-123' });
  }

  getCurrentUser(): FakeCognitoUser | null {
    return new FakeCognitoUser({ Username: 'user@example.com', Pool: this });
  }
}

class FakeAuthenticationDetails {
  constructor(_data: { Username: string; Password: string }) {
    // offline — captures nothing
  }
}

const fakeSdk = {
  CognitoUserPool: FakeCognitoUserPool,
  CognitoUser: FakeCognitoUser,
  AuthenticationDetails: FakeAuthenticationDetails,
} as unknown as CognitoSdk;

// --- Same allowlisted-returnTo helper as README (docs/plan-evidence.md rules) ---
function resolveReturnTo(raw: string | null): string {
  if (!raw) return '/';
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return '/';
  }
  if (!v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  if (/[\x00-\x1f\x7f]/.test(v)) return '/';
  const q = v.search(/[\/?#]/);
  const pre = q === -1 ? v : v.slice(0, q);
  if (pre.includes(':')) return '/';
  return raw;
}

// --- Consumer wiring (offline) ---
const navigated: string[] = [];

const cognito = new CognitoClient({
  userPoolId: 'us-east-1_XXXXXXXXX',
  clientId: 'your-app-client-id',
  sdk: fakeSdk,
  storage: memoryStorage,
  errorMapper: (err: unknown) =>
    new Error(err instanceof Error ? err.message : String(err)),
  navigate: (url: string) => {
    navigated.push(url);
  },
  getCurrentPath: () => '/dashboard?tab=settings',
});

export async function bootstrap(): Promise<void> {
  const session = await cognito.getSession();
  if (session) {
    console.log('Restored session for', session.user);
    return;
  }
  cognito.redirectToLogin('/login.html');
}

export async function loginAndReturn(
  email: string,
  password: string,
  rawReturnTo: string | null,
): Promise<string> {
  const result = await cognito.signIn(email, password);
  if (result.challenge === 'NEW_PASSWORD_REQUIRED') {
    await cognito.completeNewPassword('NewSecurePassword456!');
  }
  const target = resolveReturnTo(rawReturnTo);
  navigated.push(target);
  return target;
}

// Offline demo entry (no network, no window dependency).
void (async () => {
  await bootstrap();
  await loginAndReturn('user@example.com', 'SecurePassword123!', '/dashboard?tab=settings');
})();
