import { describe, it, expect } from 'vitest';
import { assertSessionStorageOnly, CognitoClient } from '../src/index';

function makeOptions(storage: Storage) {
  return {
    userPoolId: 'ca-central-1_abc',
    clientId: 'client-1',
    sdk: {
      CognitoUserPool: class {
        signUp(_u: string, _p: string, _a: unknown[], _v: null, cb: (e: unknown, r: unknown) => void) {
          cb(null, { userConfirmed: false, userSub: 'sub-1' });
        }
        getCurrentUser() {
          return null;
        }
      },
      CognitoUser: class {},
      AuthenticationDetails: class {},
    } as unknown as import('../src/index').CognitoSdk,
    storage,
    errorMapper: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    navigate: () => {},
  };
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('cognito-client storage guard', () => {
  it('accepts a sessionStorage-like store', () => {
    expect(() => assertSessionStorageOnly(memoryStorage())).not.toThrow();
  });

  it('rejects localStorage for refresh tokens', () => {
    const fakeLocal = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: fakeLocal,
      configurable: true,
      writable: true,
    });
    try {
      expect(() => assertSessionStorageOnly(fakeLocal)).toThrow(/sessionStorage.*localStorage is forbidden/);
    } finally {
      // jsdom exposes localStorage as getter-only on the window/global
      // proxy, so plain assignment/deletion throws or silently fails.
      // defineProperty works on both Node and jsdom globals; deleting the
      // own property restores the original jsdom accessor.
      delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    }
  });

  it('initPool fails closed when the adapter passes localStorage', async () => {
    const fakeLocal = memoryStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: fakeLocal,
      configurable: true,
      writable: true,
    });
    try {
      const client = new CognitoClient(makeOptions(fakeLocal));
      expect(() => client.signUp('a@b.ca', 'pw')).toThrow(/localStorage is forbidden/);
    } finally {
      delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    }
  });
});
