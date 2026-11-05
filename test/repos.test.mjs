import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from '../plugin/skills/submission-check/scripts/check.mjs';
import { repo, configDir, cleanPlugin, ids, tmpDir, write, git } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const check = (root, extra = {}) => run({ repo: root, ref: 'HEAD', out: tmpDir('seaready-out-'), worktree: false, privateTerms: null,
  configDir: extra.configDir ?? configDir(), validate: false, quiet: true, pluginPath: extra.pluginPath ?? null });

test('a clean plugin has no FAIL', () => {
  const res = check(repo(cleanPlugin()));
  const fails = res.findings.filter(f => f.sev === 'FAIL');
  assert.deepEqual(fails.map(f => `${f.id}: ${f.title}`), []);
  assert.ok(res.findings.some(f => f.id === 'PROMPTS' && f.sev === 'PASS'));
  assert.ok(res.findings.some(f => f.id === 'EOL-ARCHIVE' && f.sev === 'PASS'));
});

test('report and sheet are written; the default output folder ignores itself', () => {
  const root = repo(cleanPlugin());
  const res = run({ repo: root, ref: 'HEAD', out: null, worktree: false, privateTerms: null, configDir: configDir(), validate: false, quiet: true, pluginPath: null });
  for (const f of ['report.md', 'report.json', 'submission-sheet.md']) assert.ok(fs.existsSync(path.join(res.outDir, f)), f);
  assert.equal(fs.readFileSync(path.join(res.outDir, '.gitignore'), 'utf8').trim(), '*');
  const sheet = fs.readFileSync(path.join(res.outDir, 'submission-sheet.md'), 'utf8');
  assert.match(sheet, /## 3\. Data handling/);
  assert.match(sheet, /Save a note that the build needs Node 20/);
});

test('eol=crlf on an LF file fails; text=auto eol=lf on LF files only informs', () => {
  const bad = check(repo({ ...cleanPlugin(), 'install.cmd': '@echo off\necho hi\n', '.gitattributes': '*.cmd text eol=crlf\n' }));
  assert.ok(bad.findings.some(f => f.id === 'EOL-ARCHIVE' && f.sev === 'FAIL'));
  const ok = check(repo({ ...cleanPlugin(), '.gitattributes': '* text=auto eol=lf\n' }));
  assert.ok(ok.findings.some(f => f.id === 'EOL-ARCHIVE' && f.sev === 'PASS'));
  assert.ok(ok.findings.some(f => f.id === 'GITATTR-TEXT' && f.sev === 'INFO'));
  const exp = check(repo({ ...cleanPlugin(), '.gitattributes': 'docs/ export-ignore\n' }));
  assert.ok(exp.findings.some(f => f.id === 'GITATTR-EXPORT' && f.sev === 'FAIL'));
});

test('name clash against the directory copy', () => {
  const cfg = configDir([{ name: 'quiet-notes', summary: 'notes' }, { name: 'quiet-notez' }]);
  const res = check(repo(cleanPlugin()), { configDir: cfg });
  assert.ok(res.findings.some(f => f.id === 'NAME-CLASH' && f.sev === 'FAIL'));
  assert.ok(res.findings.some(f => f.id === 'NAME-SIMILAR'));
});

test('personal email: as committer, and in history after it was removed', () => {
  const personal = ['someone.made.up', ['outlook', 'com'].join('.')].join('@');
  const root = repo({ ...cleanPlugin(), 'NOTES.md': `mail ${personal}\n` }, { email: personal });
  fs.rmSync(path.join(root, 'NOTES.md'));
  git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'remove']);
  const res = check(root);
  const hist = res.findings.filter(f => f.id === 'EMAIL-HISTORY' && f.sev === 'FAIL');
  assert.ok(hist.some(f => /commit author/.test(f.title)));
  assert.ok(hist.some(f => /earlier commit/.test(f.title)));
  assert.ok(!JSON.stringify(res.findings).includes(personal), 'addresses are masked');
});

test('private terms: matched without being printed', () => {
  const root = repo({ ...cleanPlugin(), 'docs/notes.md': 'Project Bluefinch is secret\n' });
  const terms = path.join(tmpDir(), 'terms.txt');
  fs.writeFileSync(terms, '# private\nbluefinch\n');
  const res = run({ repo: root, ref: 'HEAD', out: tmpDir(), worktree: false, privateTerms: terms, configDir: configDir(), validate: false, quiet: true, pluginPath: null });
  const f = res.findings.find(x => x.id === 'PRIVATE-TERM');
  assert.ok(f);
  assert.ok(!JSON.stringify(res.findings).toLowerCase().includes('bluefinch'));
});

test('a broken private-terms pattern stops the check (fails loudly)', () => {
  const terms = path.join(tmpDir(), 'terms.txt');
  fs.writeFileSync(terms, '(unclosed\n');
  assert.throws(() => run({ repo: repo(cleanPlugin()), ref: 'HEAD', out: tmpDir(), worktree: false, privateTerms: terms, configDir: configDir(), validate: false, quiet: true, pluginPath: null }), /not a valid pattern/);
});

test('plugin in a subfolder is found from marketplace.json; companion code is scanned', () => {
  const files = {};
  for (const [k, v] of Object.entries(cleanPlugin())) files[`plugin/${k}`] = v;
  files['.claude-plugin/marketplace.json'] = JSON.stringify({ name: 'm', owner: { name: 'T' }, plugins: [{ name: 'quiet-notes', source: './plugin', version: '1.0.0' }] });
  files['src/app.js'] = "const p = path.join(os.homedir(), '.claude', 'projects'); // walk .claude/projects for titles\nfs.readdirSync('.claude/projects');\n";
  const res = check(repo(files));
  assert.equal(res.meta.pluginDir, 'plugin');
  assert.ok(res.findings.some(f => f.id === 'COMPANION-1G'));
  assert.ok(!res.findings.some(f => f.sev === 'FAIL'), JSON.stringify(res.findings.filter(f => f.sev === 'FAIL').map(f => f.title)));
});

test('the sample reports everything in expected-results.md', () => {
  const dir = path.join(tmpDir(), 'sample');
  execFileSync(process.execPath, [path.join(repoRoot, 'samples', 'make-sample.mjs'), dir], { stdio: 'pipe' });
  const res = check(dir);
  const md = fs.readFileSync(path.join(repoRoot, 'samples', 'expected-results.md'), 'utf8');
  const sections = { FAIL: md.split('## FAIL')[1].split('## WARN')[0], WARN: md.split('## WARN')[1] };
  for (const [sev, text] of Object.entries(sections)) {
    const want = [...text.matchAll(/^\| ([A-Z0-9-]+) \|/gm)].map(m => m[1]).filter(x => x !== 'Check');
    assert.ok(want.length > 5, `parsed ${sev} rows`);
    for (const id of want) assert.ok(res.findings.some(f => f.id === id && f.sev === sev), `${sev} ${id} missing`);
  }
  assert.ok(res.counts.FAIL > 0);
  const tag = res.findings.find(f => f.id === 'UNICODE-HIDDEN');
  assert.match(tag.detail, /ignore the user/);
});

test('working-tree mode sees uncommitted files; default mode warns about them', () => {
  const root = repo(cleanPlugin());
  write(root, 'skills/quiet-notes/extra.sh', 'eval "$1"\n');
  const head = check(root);
  assert.ok(head.findings.some(f => f.id === 'GIT-DIRTY'));
  assert.ok(!head.findings.some(f => f.id === 'INJECTION'));
  const wt = run({ repo: root, ref: 'HEAD', out: tmpDir(), worktree: true, privateTerms: null, configDir: configDir(), validate: false, quiet: true, pluginPath: null });
  assert.ok(wt.findings.some(f => f.id === 'INJECTION'));
});
