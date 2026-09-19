import { describe, expect, it } from 'vitest';
import packageJsonRaw from '../package.json?raw';

interface PackageMetadata {
  scripts?: Record<string, string>;
  files?: string[];
}

const pkg = JSON.parse(packageJsonRaw) as PackageMetadata;

describe('package metadata — consumer installability', () => {
  it('declares no install-time lifecycle script that would run for registry consumers', () => {
    // npm runs a dependency's preinstall/install/postinstall scripts on the
    // consumer's machine, where this package's devDependencies (TypeScript)
    // and tsconfig.build.json are absent — such a script breaks `npm install`.
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts?.[hook]).toBeUndefined();
    }
  });

  it('keeps the local build wired through prepare (never a registry-install hook)', () => {
    expect(pkg.scripts?.prepare).toBe('tsc -p tsconfig.build.json');
  });

  it('packs only self-contained artifacts (no build inputs are required at install time)', () => {
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});
