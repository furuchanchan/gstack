/**
 * #2902 — the Aside installer drops the CLI at `~/.local/bin/aside`, which is
 * NOT on the default macOS login PATH. A PATH-only probe reported a running,
 * signed-in Aside as NEEDS_ASIDE ("download it"), and every browsing surface
 * silently dropped to the bundled headless browser.
 *
 * Pins: resolveAsideBin prefers PATH, then the installer's location;
 * probeAside accepts a CLI found only there; the opt-out still short-circuits
 * first; a present-but-broken file is still NEEDS_ASIDE.
 *
 * Deterministic on hosts without `aside` on PATH (CI included): `aside` is
 * not installed here, so the PATH branch always misses and only the
 * ~/.local/bin fallback is exercised.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { probeAside, resolveAsideBin } from '../lib/aside-render';

let tmpHome: string;
let prevHome: string | undefined;
let prevSkip: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gstack-aside-home-'));
  prevHome = process.env.HOME;
  prevSkip = process.env.GSTACK_SKIP_ASIDE;
  process.env.HOME = tmpHome;
  delete process.env.GSTACK_SKIP_ASIDE;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevSkip === undefined) delete process.env.GSTACK_SKIP_ASIDE;
  else process.env.GSTACK_SKIP_ASIDE = prevSkip;
  rmSync(tmpHome, { recursive: true, force: true });
});

function fakeAside(body: string, executable = true): string {
  const dir = join(tmpHome, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'aside');
  writeFileSync(bin, body);
  if (executable) chmodSync(bin, 0o755);
  return bin;
}

const HEALTHY_ASIDE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9-local"; exit 0; fi
if [ "$1" = "repl" ]; then echo "ASIDE_READY /tmp/fake-session"; exit 0; fi
exit 1
`;

describe('resolveAsideBin / probeAside — installer location fallback (#2902)', () => {
  test('a CLI present only at ~/.local/bin/aside resolves and probes READY', () => {
    const bin = fakeAside(HEALTHY_ASIDE);
    expect(resolveAsideBin()).toBe(bin);
    const probe = probeAside();
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.version).toBe('9.9.9-local');
  });

  test('no PATH hit and no ~/.local/bin/aside → NEEDS_ASIDE, naming the checked location', () => {
    expect(resolveAsideBin()).toBeNull();
    const probe = probeAside();
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.reason).toBe('NEEDS_ASIDE');
      expect(probe.detail).toContain('.local/bin');
    }
  });

  test('a non-executable file at ~/.local/bin/aside is still NEEDS_ASIDE', () => {
    fakeAside(HEALTHY_ASIDE, /* executable */ false);
    expect(resolveAsideBin()).toBeNull();
    const probe = probeAside();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toBe('NEEDS_ASIDE');
  });

  test('a CLI answering --version but never ASIDE_READY → ASIDE_NOT_RUNNING (not install advice)', () => {
    fakeAside(`#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9-local"; exit 0; fi
exit 1
`);
    const probe = probeAside();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toBe('ASIDE_NOT_RUNNING');
  });

  test('GSTACK_SKIP_ASIDE=1 still short-circuits before any location check', () => {
    fakeAside(HEALTHY_ASIDE);
    process.env.GSTACK_SKIP_ASIDE = '1';
    const probe = probeAside();
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toBe('NEEDS_ASIDE');
  });
});
