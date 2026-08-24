import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { hasMissingDependency, needsInstall } from '../../scripts/ensure-deps.mjs';

describe('hasMissingDependency', () => {
  it('returns true when a dependency folder is missing', () => {
    const modulesPath = path.join(path.parse(process.cwd()).root, 'repo', 'node_modules');
    const pathExists = vi.fn((targetPath: string) => targetPath !== path.join(modulesPath, 'jszip'));

    expect(hasMissingDependency({ jszip: '^3.10.1' }, modulesPath, pathExists)).toBe(true);
  });

  it('handles scoped package names', () => {
    const pathExists = vi.fn(() => true);
    const modulesPath = path.join(path.parse(process.cwd()).root, 'repo', 'node_modules');

    expect(hasMissingDependency({ '@scope/pkg': '1.0.0' }, modulesPath, pathExists)).toBe(false);
    expect(pathExists).toHaveBeenCalledWith(path.join(modulesPath, '@scope/pkg'));
  });

  it('treats missing dependency metadata as no missing packages', () => {
    expect(hasMissingDependency(undefined, '/repo/node_modules', vi.fn())).toBe(false);
  });
});

describe('needsInstall', () => {
  it('returns true when node_modules is missing', () => {
    const pathExists = vi.fn((targetPath: string) => targetPath !== '/repo/node_modules');

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: '/repo/node_modules',
        lockPath: '/repo/package-lock.json',
        installedLock: '/repo/node_modules/.package-lock.json',
        pathExists,
      }),
    ).toBe(true);
  });

  it('returns true when lock metadata is missing', () => {
    const pathExists = vi.fn((targetPath: string) => targetPath !== '/repo/node_modules/.package-lock.json');

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: '/repo/node_modules',
        lockPath: '/repo/package-lock.json',
        installedLock: '/repo/node_modules/.package-lock.json',
        pathExists,
      }),
    ).toBe(true);
  });

  it('returns true when package-lock is newer than installed metadata', () => {
    const pathExists = vi.fn(() => true);
    const getStat = vi.fn((targetPath: string) => ({
      mtimeMs: targetPath === '/repo/package-lock.json' ? 20 : 10,
    }));

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1' },
        modulesPath: '/repo/node_modules',
        lockPath: '/repo/package-lock.json',
        installedLock: '/repo/node_modules/.package-lock.json',
        pathExists,
        getStat,
      }),
    ).toBe(true);
  });

  it('returns false when dependencies are present and lock metadata is current', () => {
    const pathExists = vi.fn(() => true);
    const getStat = vi.fn(() => ({ mtimeMs: 10 }));

    expect(
      needsInstall({
        dependencies: { jszip: '^3.10.1', '@scope/pkg': '1.0.0' },
        modulesPath: '/repo/node_modules',
        lockPath: '/repo/package-lock.json',
        installedLock: '/repo/node_modules/.package-lock.json',
        pathExists,
        getStat,
      }),
    ).toBe(false);
  });
});
