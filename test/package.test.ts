import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// Mirrors the automated "Verified by Homebridge" package checks, so a release can't regress them.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package.json (Homebridge verification checks)', () => {
  test('keywords mark it as a Homebridge plugin and declare the HAP transport', () => {
    expect(pkg.keywords).toEqual(expect.arrayContaining(['homebridge-plugin', 'supports-hap']));
  });

  test('no install-time scripts', () => {
    for (const script of ['preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts?.[script]).toBeUndefined();
    }
  });

  test('homebridge and hap-nodejs are never runtime or peer dependencies', () => {
    const declared = { ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    expect(Object.keys(declared)).not.toContain('homebridge');
    expect(Object.keys(declared)).not.toContain('hap-nodejs');
  });

  test('homepage and bugs point to the public GitHub repo over https', () => {
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\/plugpulled\/homebridge-superfan/);
    expect(pkg.bugs.url).toMatch(/^https:\/\/github\.com\/plugpulled\/homebridge-superfan\/issues/);
  });
});
