/**
 * GSTACK_CODEX_EFFORT — operator-pinned default reasoning effort (#2975).
 *
 * Contract:
 *   - unset                -> per-mode defaults, no behaviour change
 *   - low|medium|high|xhigh|max -> used for review, challenge and consult;
 *     every command spells the env expansion `${GSTACK_CODEX_EFFORT:-<mode>}`
 *     so the default lands at exec time without the agent rewriting the flag
 *   - `--xhigh` on a request still wins (prose contract in each mode section)
 *   - an unknown value is refused by _gstack_codex_effort_check in Step 0.5,
 *     BEFORE any paid call — Codex itself only rejects a bad
 *     model_reasoning_effort at request time, as an API error
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin', 'gstack-codex-probe');

function runCheck(env?: Record<string, string | undefined>): { stdout: string; stderr: string; status: number } {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '', _TEL: 'off' };
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined) delete clean[k]; else clean[k] = v;
  }
  const r = spawnSync('bash', ['-c', `set +e\nsource "${PROBE}"\n_gstack_codex_effort_check\necho "STATUS:$?"`], {
    env: clean, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
  });
  const stdout = r.stdout.toString();
  const status = Number(stdout.match(/STATUS:(\d+)/)?.[1]);
  return { stdout, stderr: r.stderr.toString(), status };
}

describe('_gstack_codex_effort_check', () => {
  test('unset env is a silent pass (per-mode defaults keep working)', () => {
    const r = runCheck({ GSTACK_CODEX_EFFORT: undefined });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('CODEX_EFFORT');
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts "%s" and names its source', (level) => {
    const r = runCheck({ GSTACK_CODEX_EFFORT: level });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`CODEX_EFFORT: ${level}`);
    expect(r.stderr).toContain('GSTACK_CODEX_EFFORT');
  });

  test.each(['MAX', 'extreme', '2', 'high '])('refuses "%s" with a repair message, before any call', (bad) => {
    const r = runCheck({ GSTACK_CODEX_EFFORT: bad });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CODEX_EFFORT: invalid');
    expect(r.stderr).toContain('low|medium|high|xhigh|max');
    expect(r.stderr).toContain('no Codex call was made');
  });
});

describe('GSTACK_CODEX_EFFORT wiring', () => {
  const sectionFiles = ['review-mode', 'challenge-mode', 'consult-mode']
    .map((m) => path.join(ROOT, 'codex', 'sections', `${m}.md.tmpl`));

  test('every model_reasoning_effort flag expands the env var — no bare literal remains', () => {
    // The flag lives in the mode sections (and their generated copies), not the
    // SKILL.md skeleton — assert no bare literal anywhere, the expansion where
    // the flag actually appears.
    const flagFiles = [path.join(ROOT, 'codex', 'SKILL.md'), ...sectionFiles,
      ...sectionFiles.map((f) => f.replace('.md.tmpl', '.md'))];
    for (const file of flagFiles) {
      const text = fs.readFileSync(file, 'utf-8');
      const literals = text.match(/-c ['"]model_reasoning_effort=\\?"[a-z]+\\?"/g) ?? [];
      expect(literals, `${file}: bare -c literal ${literals[0]}`).toEqual([]);
      for (const m of text.matchAll(/-c ['"]model_reasoning_effort=\\?"(.*?)\\?"/g)) {
        expect(m[1]).toMatch(/^\$\{GSTACK_CODEX_EFFORT:-(high|medium)\}$/);
      }
    }
    for (const file of sectionFiles) {
      expect(fs.readFileSync(file, 'utf-8')).toContain('${GSTACK_CODEX_EFFORT:-');
    }
  });

  test('consult keeps medium as its fallback; review and challenge keep high', () => {
    expect(fs.readFileSync(sectionFiles[2], 'utf-8')).toContain('${GSTACK_CODEX_EFFORT:-medium}');
    expect(fs.readFileSync(sectionFiles[2], 'utf-8')).not.toContain('${GSTACK_CODEX_EFFORT:-high}');
    for (const f of [sectionFiles[0], sectionFiles[1]]) {
      expect(fs.readFileSync(f, 'utf-8')).toContain('${GSTACK_CODEX_EFFORT:-high}');
    }
  });

  test('--xhigh still wins: each mode section names it over the env var', () => {
    for (const f of sectionFiles) {
      const text = fs.readFileSync(f, 'utf-8');
      expect(text, `${f} missing the --xhigh precedence note`).toContain('`--xhigh`');
      expect(text, `${f} missing the --xhigh precedence note`).toContain('overrides `GSTACK_CODEX_EFFORT`');
    }
  });

  test('skill wires the preflight check in Step 0.5 and documents the var in Model & Reasoning', () => {
    const skill = fs.readFileSync(path.join(ROOT, 'codex', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('_gstack_codex_effort_check');
    expect(skill).toContain('GSTACK_CODEX_EFFORT_INVALID');
    const mr = skill.split('## Model & Reasoning')[1]?.split('\n## ')[0] ?? '';
    expect(mr).toContain('GSTACK_CODEX_EFFORT');
    expect(mr).toContain('low|medium|high|xhigh|max');
  });
});
