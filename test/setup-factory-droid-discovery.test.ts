/**
 * setup: link_factory_skill_dirs — Factory Droid discovery (#661).
 *
 * Droid loads a skill only when all three hold: a RELATIVE symlink in
 * ~/.factory/skills, a REAL directory in ~/.agents/skills, and a lockfile
 * entry in ~/.agents/.skill-lock.json with sourceType "github". The old
 * install wrote absolute symlinks into the repo's render tree and never
 * registered, so every gstack skill was invisible to Droid's `/` menu.
 *
 * Behavior fixture: extract the helpers from setup and run them against a
 * temp HOME tree (same pattern as setup-prune-stale-generated.test.ts).
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
const BANNER = '<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->\n';
const BUN = process.env.BUN_BIN ?? path.join(os.homedir(), '.bun', 'bin', 'bun');

function extractFn(name: string): string {
  const start = SETUP_SRC.indexOf(`${name}() {`);
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Could not locate ${name}() in setup`);
  return SETUP_SRC.slice(start, end + 2);
}

/** A temp HOME with a render tree holding the given gstack-* skills. */
function mk(t: string, skills: string[]) {
  const home = path.join(t, 'home');
  const gen = path.join(t, 'gstack-checkout', '.factory', 'skills');
  const factory = path.join(home, '.factory', 'skills');
  fs.mkdirSync(factory, { recursive: true });
  for (const s of skills) {
    fs.mkdirSync(path.join(gen, s), { recursive: true });
    fs.writeFileSync(path.join(gen, s, 'SKILL.md'), `${BANNER}# ${s}\n`);
  }
  return { home, gen, factory };
}

function runLink(home: string, gen: string, factory: string, extra = '') {
  const script = [
    'set -e',
    `HOME=${JSON.stringify(home)}`,
    'IS_WINDOWS=0',
    `BUN_CMD=${JSON.stringify(BUN)}`,
    'bun_cmd() { "$BUN_CMD" "$@"; }',
    extra,
    extractFn('_owned_for_windows_refresh'),
    extractFn('_remove_disabled_host_entry'),
    extractFn('_link_or_copy'),
    extractFn('_factory_lockfile_update'),
    extractFn('link_factory_skill_dirs'),
    `link_factory_skill_dirs ${JSON.stringify(path.dirname(path.dirname(gen)))} ${JSON.stringify(factory)}`,
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 60_000 });
}

const lockfile = (home: string) => JSON.parse(fs.readFileSync(path.join(home, '.agents', '.skill-lock.json'), 'utf-8'));

describe('setup: factory host lands in Droid discovery layout (#661)', () => {
  test('skills land as real dirs under ~/.agents/skills with relative factory symlinks + github lockfile entries', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa', 'gstack-review']);
      const r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      for (const s of ['gstack-qa', 'gstack-review']) {
        const agentsDir = path.join(home, '.agents', 'skills', s);
        // Real directory, not a symlink into the repo.
        expect(fs.lstatSync(agentsDir).isDirectory()).toBe(true);
        expect(fs.lstatSync(agentsDir).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(path.join(agentsDir, 'SKILL.md'), 'utf-8')).toContain(`# ${s}`);
        // Relative symlink — the only shape Droid follows.
        const link = path.join(factory, s);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(link)).toBe(`../../.agents/skills/${s}`);
        // And it resolves to the agents dir.
        expect(fs.realpathSync(link)).toBe(fs.realpathSync(agentsDir));
      }
      const lock = lockfile(home);
      expect(lock.skills['gstack-qa'].sourceType).toBe('github');
      expect(lock.skills['gstack-review'].sourceType).toBe('github');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('old-style absolute factory symlink is migrated to the relative pointer', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa']);
      fs.symlinkSync(path.join(gen, 'gstack-qa'), path.join(factory, 'gstack-qa'));
      const r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      expect(fs.readlinkSync(path.join(factory, 'gstack-qa'))).toBe('../../.agents/skills/gstack-qa');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('a foreign real dir in ~/.agents/skills is left in place and unregistered', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa']);
      const foreign = path.join(home, '.agents', 'skills', 'gstack-qa');
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, 'SKILL.md'), '# hand-written\n');
      const r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      expect(r.stderr + r.stdout).toContain('not gstack-managed');
      // Untouched — an unbannered real dir is not provably ours (#2142 rule).
      expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf-8')).toBe('# hand-written\n');
      // No lockfile entry for content we did not install.
      expect(() => lockfile(home)).toThrow();
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('lockfile preserves foreign entries, upgrades local ones, and disabled skills are removed everywhere', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa', 'gstack-zzz']);
      // Pre-existing lockfile: a foreign github entry and a stale local one.
      fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
      fs.writeFileSync(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify({
        skills: {
          'other-skill': { sourceType: 'github', sourceUrl: 'https://github.com/other/x' },
          'gstack-qa': { sourceType: 'local', sourceUrl: 'file:///old/path' },
          'gstack-zzz': { sourceType: 'github', sourceUrl: 'https://github.com/not-gstack/hijack' },
        },
      }) + '\n');
      const r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      const lock = lockfile(home);
      expect(lock.skills['other-skill']).toEqual({ sourceType: 'github', sourceUrl: 'https://github.com/other/x' });
      expect(lock.skills['gstack-qa'].sourceType).toBe('github');
      expect(lock.skills['gstack-qa'].sourceUrl).toBe('https://github.com/garrytan/gstack');
      // Foreign github entry not ours to overwrite.
      expect(lock.skills['gstack-zzz'].sourceUrl).toBe('https://github.com/not-gstack/hijack');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('disabled skill is removed from both namespaces and unregistered', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa', 'gstack-review']);
      // Seed a prior install + lockfile entries.
      let r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'gstack-qa'))).toBe(true);
      // Now disable qa and re-run.
      r = runLink(home, gen, factory, '_DISABLED_SKILLS=" qa "');
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'gstack-qa'))).toBe(false);
      expect(fs.existsSync(path.join(factory, 'gstack-qa'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'gstack-review'))).toBe(true);
      const lock = lockfile(home);
      expect(lock.skills['gstack-qa']).toBeUndefined();
      expect(lock.skills['gstack-review'].sourceType).toBe('github');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });

  test('a previously installed bannered copy refreshes on re-run (#2444 semantics in ~/.agents/skills)', () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'factory661-'));
    try {
      const { home, gen, factory } = mk(t, ['gstack-qa']);
      expect(runLink(home, gen, factory).status).toBe(0);
      // Upstream render changes; re-run must refresh the real copy.
      fs.writeFileSync(path.join(gen, 'gstack-qa', 'SKILL.md'), `${BANNER}# gstack-qa v2\n`);
      const r = runLink(home, gen, factory);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(home, '.agents', 'skills', 'gstack-qa', 'SKILL.md'), 'utf-8')).toContain('v2');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  });
});
