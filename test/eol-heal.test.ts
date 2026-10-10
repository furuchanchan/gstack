/**
 * #3110: Windows checkouts write nested hook shims with CRLF, which breaks
 * them when a Linux bash later runs the same bytes. `.gitattributes` must pin
 * every tracked `#!` file to LF (a pattern containing a slash is anchored to
 * the repo root, so `bin/*` alone misses `autoplan/bin`, `hosts/<h>/hooks`,
 * `lib/cso/images`, etc.), and `scripts/heal-eol.sh` rewrites the stale CRLF
 * copies an old checkout left behind — git never rewrites an unchanged blob.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const HEAL = path.join(ROOT, 'scripts', 'heal-eol.sh');

function git(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function crlfRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eol-'));
  git(dir, ['init', '-q']);
  fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(dir, '.gitattributes'));
  fs.mkdirSync(path.join(dir, 'nested/bin'), { recursive: true });
  const script = '#!/bin/bash\nset -euo pipefail\necho ok\n';
  fs.writeFileSync(path.join(dir, 'nested/bin/hook'), script);
  fs.writeFileSync(path.join(dir, '.gitattributes'), fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  // Simulate a Windows autocrlf=true checkout: same blob, CRLF working copy.
  fs.writeFileSync(path.join(dir, 'nested/bin/hook'), script.replace(/\n/g, '\r\n'));
  return dir;
}

describe('#3110: every tracked shebang file pins eol=lf', () => {
  test('git check-attr reports lf for every `#!` path in the index', () => {
    const files = git(ROOT, ['ls-files']).split('\n').filter(Boolean)
      .filter((f) => { const p = path.join(ROOT, f); return fs.existsSync(p) && fs.statSync(p).isFile() && fs.readFileSync(p).subarray(0, 2).toString() === '#!'; });
    expect(files.length).toBeGreaterThan(100);
    const missing = files.filter((f) => !git(ROOT, ['check-attr', 'eol', '--', f]).trimEnd().endsWith(': lf'));
    expect(missing).toEqual([]);
  });
});

describe('#3110: heal-eol.sh', () => {
  test('rewrites a stale CRLF copy to LF and re-stages it cleanly', () => {
    const dir = crlfRepo();
    const r = spawnSync('bash', [HEAL, dir], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
    const healed = fs.readFileSync(path.join(dir, 'nested/bin/hook'), 'utf8');
    expect(healed).not.toContain('\r');
    expect(healed).toContain('#!/bin/bash');
    // Re-staged: the healed file is not left as a phantom modification.
    expect(git(dir, ['status', '--porcelain'])).toBe('');
  });

  test('leaves a locally-modified CRLF copy untouched', () => {
    const dir = crlfRepo();
    fs.appendFileSync(path.join(dir, 'nested/bin/hook'), 'echo local\n');
    const r = spawnSync('bash', [HEAL, dir], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'nested/bin/hook'), 'utf8')).toContain('\r\n');
    expect(git(dir, ['status', '--porcelain'])).toContain('M nested/bin/hook');
  });
});
