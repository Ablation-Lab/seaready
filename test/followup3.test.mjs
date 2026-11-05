// Regression tests for the third round (2026-11-05): chat-history words in the README's comparison
// section are a WARN for the judgement step (no name heuristics), the section ends at any heading, and a
// run removes its own temporary folders, as do the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from '../plugin/skills/submission-check/scripts/check.mjs';
import { repo, configDir, cleanPlugin, tmpDir, write } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'plugin', 'skills', 'submission-check', 'scripts');
const checkJs = path.join(scripts, 'check.mjs');
const check = root => run({ repo: root, ref: 'HEAD', out: tmpDir('seaready-out-'), worktree: false, privateTerms: null, configDir: configDir(), validate: false, quiet: true, pluginPath: null });
const chat = (res, sev) => res.findings.filter(x => x.id === 'CHAT-HISTORY' && x.sev === sev);
const SAYS = ' reads the session summary of each conversation.';

test('every chat-history claim in the README comparison section is a WARN to read, whatever the line looks like', () => {
  // The shapes the second-round recheck found downgraded to INFO, and plain claims that were a FAIL.
  for (const line of [
    `- **Focus Mode** keeps a timer, while Quiet Notes${SAYS}`,
    `- **Focus Mode** is a timer. Quiet Notes${SAYS}`,
    `- **Unlike Focus Mode**, Quiet Notes${SAYS}`,
    `- **Tip:** it${SAYS}`,
    `- \`/recap\`${SAYS}`,
    `It${SAYS}`,
    `Focus Mode${SAYS}`,
  ]) {
    const f = cleanPlugin();
    f['README.md'] += `\n## How it compares\n\n${line}\n`;
    const res = check(repo(f));
    assert.equal(chat(res, 'INFO').length, 0, `no INFO: ${line}`);
    assert.equal(chat(res, 'FAIL').length, 0, `not decided by the script: ${line}`);
    assert.ok(chat(res, 'WARN').some(x => /comparison section/.test(x.title)), `a WARN for the judgement step: ${line}`);
  }
});

test('outside the comparison section the same claims stay a FAIL', () => {
  const f = cleanPlugin();
  f['README.md'] += `\n## Usage\n\n- **Focus Mode** keeps a timer, while Quiet Notes${SAYS}\n`;
  assert.ok(chat(check(repo(f)), 'FAIL').length);
  const g = cleanPlugin();
  g['skills/quiet-notes/SKILL.md'] += `\n## How it compares\n\n- **Focus Mode**${SAYS}\n`;
  assert.ok(chat(check(repo(g)), 'FAIL').length, 'SKILL.md has no comparison sections');
});

test('the comparison section ends at any heading of the same or a higher level, whatever the comment state', () => {
  for (const ender of [
    '- **Focus Mode** uses `<!--` markers.\n\n## Privacy details',   // inline <!-- must not keep the section open
    '- **Focus Mode** is a timer.\n\n ## Behaviour',                  // indented heading
    '- **Focus Mode** is a timer.\n\nBehaviour\n---------',          // setext heading
    '- **Focus Mode** is a timer.\n\n<h2>Behaviour</h2>',            // HTML heading
  ]) {
    const f = cleanPlugin();
    f['README.md'] += `\n## How it compares\n\n${ender}\n\n- **Quick note:** it${SAYS}\n`;
    const res = check(repo(f));
    assert.ok(chat(res, 'FAIL').length, `ended before the claim: ${ender.split('\n').pop()}`);
  }
});

// Lists the temporary folders a run leaves in `dir`.
const leftovers = dir => fs.readdirSync(dir).filter(n => /^seaready-(cwd|mirror)-/.test(n));
const envFor = dir => { const e = { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir }; delete e.NODE_TEST_CONTEXT; return e; };

test('a run removes its own temporary folders when it finishes, fails or stops on an error', () => {
  const root = repo(cleanPlugin());
  const bad = tmpDir('seaready-terms-');
  write(bad, 'terms.txt', '(unclosed\n');
  for (const args of [
    [root, '--no-validate'],                                    // finishes
    [root, '--no-validate', '--ref', 'no-such-ref'],            // can't run: exit 2
    [root, '--no-validate', '--private-terms', path.join(bad, 'terms.txt')],   // broken pattern: stops loudly
    [path.join(root, 'no-such-folder')],                        // no such folder
  ]) {
    const t = tmpDir('seaready-tempdir-');
    const out = tmpDir('seaready-out-');
    const r = spawnSync(process.execPath, [checkJs, ...args, '--out', out], { env: envFor(t), encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, args.length === 2 ? 0 : 2, `${args.join(' ')}: ${r.stderr}`);   // it really ran (or really stopped)
    assert.deepEqual(leftovers(t), [], args.join(' '));
  }
});

test('run() itself removes its temporary folders, before the process exits', () => {
  // In a fresh process, so the folders are made in the redirected temp folder; listed while the process
  // is still running, so only run()'s own clean-up counts (not the exit handler).
  const root = repo(cleanPlugin());
  const t = tmpDir('seaready-tempdir-');
  const probe = tmpDir('seaready-probe-');
  const checkUrl = pathToFileURL(checkJs).href;
  const cfg = configDir();
  write(probe, 'p.mjs', [
    `import fs from 'node:fs';`,
    `import { run } from ${JSON.stringify(checkUrl)};`,
    `const o = { repo: ${JSON.stringify(root)}, out: ${JSON.stringify(path.join(probe, 'out'))}, worktree: false, privateTerms: null, configDir: ${JSON.stringify(cfg)}, validate: false, quiet: true, pluginPath: null };`,
    `run({ ...o, ref: 'HEAD' });`,
    `try { run({ ...o, ref: 'no-such-ref' }); } catch {}`,
    `console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(t)}).filter(n => /^seaready-(cwd|mirror)-/.test(n))));`,
  ].join('\n'));
  const r = spawnSync(process.execPath, [path.join(probe, 'p.mjs')], { env: envFor(t), encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), []);
});

// (The Ctrl+C handler test that was here called the handler with process.emit, not a real signal, and
// so missed that the handlers stopped Ctrl+C from working. The handlers are gone; test/interrupt.test.mjs
// sends a real interrupt instead.)

test('the test suite cleans up: a test file leaves nothing in the temp folder', () => {
  const t = tmpDir('seaready-tempdir-');
  execFileSync(process.execPath, ['--test', path.join(here, 'followup.test.mjs')], { env: envFor(t), stdio: 'pipe', timeout: 300000 });
  assert.deepEqual(fs.readdirSync(t), []);
});
