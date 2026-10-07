/**
 * setup: _adopt_installed_bun — a bun just installed by the official
 * installer lands in ~/.bun/bin but is absent from the INVOKING shell's PATH
 * (the installer only amends new shells). Re-running ./setup used to fail
 * with "bun is required" even though bun was on disk (#466). Setup now adopts
 * the standard install dir into PATH before declaring bun missing.
 *
 * Behavior fixture: extract the helper and run it with a PATH that has no
 * bun, against a fake HOME carrying a stub bun binary.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

function run(home: string) {
  const script = [
    `HOME=${JSON.stringify(home)}`,
    'unset USERPROFILE LOCALAPPDATA 2>/dev/null || true',
    extractFn('_adopt_installed_bun'),
    'if _adopt_installed_bun; then echo "ADOPTED"; else echo "MISSING"; fi',
    'command -v bun || true',
    'printf "PATH=%s\\n" "$PATH"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    timeout: 15_000,
    env: { PATH: '/usr/bin:/bin' },
  });
}

function mkStub(home: string) {
  const dir = path.join(home, '.bun', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'bun');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return dir;
}

describe('setup: _adopt_installed_bun (#466)', () => {
  test('adopts a freshly installed ~/.bun/bin into PATH', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-bun-'));
    try {
      const stubDir = mkStub(t);
      const r = run(t);
      expect(r.stdout).toContain('ADOPTED');
      expect(r.stdout).toContain(`${stubDir}/bun`);
      expect(r.stdout).toContain(`PATH=${stubDir}:`);
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('no bun on disk or PATH → returns 1 so the installer hint still prints', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-bun-'));
    try {
      const r = run(t);
      expect(r.stdout).toContain('MISSING');
      expect(r.stdout).not.toContain('ADOPTED');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('a .bun/bin dir without a bun binary is not adopted', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-bun-'));
    try {
      fs.mkdirSync(path.join(t, '.bun', 'bin'), { recursive: true });
      const r = run(t);
      expect(r.stdout).toContain('MISSING');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('wiring: adoption runs before the not-installed error in setup', () => {
    const adopt = SETUP_SRC.indexOf('_adopt_installed_bun || true');
    const err = SETUP_SRC.indexOf('bun is required but not installed');
    expect(adopt).toBeGreaterThan(0);
    expect(err).toBeGreaterThan(adopt);
    expect(SETUP_SRC).toContain('Add its directory to PATH (usually ~/.bun/bin) and re-run ./setup.');
  });
});
