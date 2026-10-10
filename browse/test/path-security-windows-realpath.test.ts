import { describe, it, expect } from 'bun:test';
import { join } from 'path';
import { isPathWithin } from '../src/platform';

// Windows 8.3 (#3104): a username >8 chars makes Windows hand os.tmpdir() the
// short form (C:\Users\BURCIN~1\...). JS realpathSync keeps 8.3 components
// while realpathSync.native expands them — so SAFE dirs (non-native) and
// targets (native) compared the short form against the long form and rejected
// every temp-dir path. The fix resolves both sides with realpathSync.native.
// POSIX can't mint an 8.3 name, so the guard pins the resolver each side
// actually calls, via a child process whose fs exports are patched before
// path-security loads.
const ROOT = join(import.meta.dir, '..', '..');

function probe(): { safe: boolean; importCalls: string[]; readCalls: string[]; tempCalls: string[] } {
  const r = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'fixtures', 'path-security-realpath-probe.ts'), ROOT],
    { cwd: ROOT, env: { ...process.env } },
  );
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.toString());
}

describe('path-security 8.3 realpath normalization (#3104)', () => {
  it('SAFE dirs, validateReadPath and validateTempPath all resolve via realpathSync.native', () => {
    const r = probe();
    expect(r.safe).toBe(true);
    for (const calls of [r.importCalls, r.readCalls, r.tempCalls]) {
      expect(calls).toContain('native');
      expect(calls).not.toContain('js');
    }
  });

  it('isPathWithin folds case under caseInsensitive (win32 seam)', () => {
    expect(isPathWithin('/TMP/Foo/a.png', '/tmp/foo', true)).toBe(true);
    expect(isPathWithin('/TMP/Foo/a.png', '/tmp/foo', false)).toBe(false);
  });
});
