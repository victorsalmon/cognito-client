/**
 * Quickstart for `@clocklobster/cognito-client`.
 *
 * Runs offline in Node with a stub SDK and in-memory storage — no Cognito user
 * pool, network, or browser needed. In a real app, pass the
 * `amazon-cognito-identity-js` namespace as `sdk` and `sessionStorage` as
 * `storage` (see the README "Quick start").
 *
 * Run with any TypeScript runner, e.g. `npx tsx examples/quickstart.ts`.
 */
import { CognitoClient } from '../src/index.js';

// In-memory Storage stand-in (a browser app passes `sessionStorage` so tokens
// clear on tab close instead of persisting in `localStorage`).
const memory = new Map<string, string>();
const storage: Storage = {
  get length() {
    return memory.size;
  },
  clear: () => {
    memory.clear();
  },
  getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
  key: (index: number) => [...memory.keys()][index] ?? null,
  removeItem: (key: string) => {
    memory.delete(key);
  },
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};

const unimplemented = (name: string) => () => {
  throw new Error(`${name} is not implemented in the quickstart stub SDK`);
};

// Minimal stub of the amazon-cognito-identity-js namespace with no cached user.
const stubSdk = {
  CognitoUserPool: class {
    constructor(_data: unknown) {}
    signUp = unimplemented('signUp');
    getCurrentUser(): null {
      return null;
    }
  },
  CognitoUser: class {
    constructor(_data: unknown) {}
    authenticateUser = unimplemented('authenticateUser');
    getSession = unimplemented('getSession');
    confirmRegistration = unimplemented('confirmRegistration');
    forgotPassword = unimplemented('forgotPassword');
    confirmPassword = unimplemented('confirmPassword');
    signOut(): void {}
    getUsername(): string {
      return '';
    }
    setSignInUserSession = unimplemented('setSignInUserSession');
  },
  AuthenticationDetails: class {
    constructor(_data: unknown) {}
  },
};

const cognito = new CognitoClient({
  userPoolId: 'us-east-1_EXAMPLE',
  clientId: 'example-app-client-id',
  sdk: stubSdk,
  storage: () => storage,
  errorMapper: (err) => (err instanceof Error ? err : new Error(String(err))),
  navigate: (url) => {
    console.log('navigate:', url);
  },
  getCurrentPath: () => '/dashboard?tab=billing',
});

console.log('user:', cognito.getUser()); // null — nobody signed in
console.log('session:', await cognito.getSession()); // null — no cached user
cognito.redirectToLogin('/login'); // navigate: /login?returnTo=%2Fdashboard%3Ftab%3Dbilling
