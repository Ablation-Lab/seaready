// Regression tests for the second fresh recheck (2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '../plugin/skills/submission-check/scripts/check.mjs';
import { parseGitVersion, MIN_GIT } from '../plugin/skills/submission-check/scripts/lib/git.mjs';
import { disclosed } from '../plugin/skills/submission-check/scripts/lib/checks.mjs';
import * as R from '../plugin/skills/submission-check/scripts/lib/rules.mjs';
import { repo, configDir, cleanPlugin, tmpDir, write, git } from './helpers.mjs';

const check = (root, o = {}) => run({ repo: root, ref: 'HEAD', out: tmpDir('seaready-out-'), worktree: false, privateTerms: o.privateTerms || null,
  configDir: configDir(), validate: false, quiet: true, pluginPath: null, noRepoTerms: !!o.noRepoTerms });
const has = (res, id, sev) => res.findings.some(f => f.id === id && (!sev || f.sev === sev));
const withManifest = extra => ({ ...cleanPlugin(), '.claude-plugin/plugin.json': JSON.stringify({ ...JSON.parse(cleanPlugin()['.claude-plugin/plugin.json']), ...extra }) });

test('B: git older than 2.44 is refused, and this machine\'s git is new enough', () => {
  assert.deepEqual(MIN_GIT, [2, 44]);
  assert.deepEqual(parseGitVersion('git version 2.39.5 (Apple Git-154)'), [2, 39]);
  assert.deepEqual(parseGitVersion('git version 2.55.0.windows.3'), [2, 55]);
  const v = parseGitVersion(execFileSync('git', ['--version'], { encoding: 'utf8' }));
  assert.ok(v[0] > 2 || v[1] >= 44, 'tests need git 2.44+');
});

test('B: a custom transport helper on a promisor remote can\'t run a program', () => {
  const root = repo(cleanPlugin());
  const marker = path.join(tmpDir(), 'ran.txt').replace(/\\/g, '/');
  git(root, ['remote', 'add', 'origin', 'https://github.com/v/quiet-notes.git']);
  git(root, ['config', 'core.repositoryformatversion', '1']);
  git(root, ['config', 'extensions.partialClone', 'evil']);
  git(root, ['config', 'remote.evil.url', 'evilh::x']);
  git(root, ['config', 'remote.evil.promisor', 'true']);
  git(root, ['config', 'protocol.evilh.allow', 'always']);
  git(root, ['config', 'alias.remote-evilh', `!node -e "require('fs').writeFileSync('${marker}','x')"`]);
  fs.mkdirSync(path.join(root, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'refs', 'remotes', 'origin', 'main'), '2'.repeat(40) + '\n');
  try { check(root); } catch { /* refusing is fine */ }
  assert.ok(!fs.existsSync(marker), 'a custom helper ran');
});

test('2: hooks and MCP servers declared in plugin.json are checked, inline or by path', () => {
  const inline = check(repo(withManifest({ mcpServers: { x: { command: 'npx', args: ['evil-pkg'] } }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npx evil-pkg2' }] }] } })));
  assert.equal(inline.findings.filter(f => f.id === 'LAUNCHER' && f.sev === 'FAIL').length, 2);
  assert.ok(inline.findings.some(f => f.id === 'HOOKS' && f.sev === 'INFO' && /1 command hook/.test(f.title)));
  const paths = check(repo({ ...withManifest({ mcpServers: './servers.json', hooks: './h/my-hooks.json' }),
    'servers.json': JSON.stringify({ mcpServers: { y: { command: 'uvx', args: ['tool'] } } }),
    'h/my-hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'pnpm exec thing' }] }] } }) }));
  assert.equal(paths.findings.filter(f => f.id === 'LAUNCHER' && f.sev === 'FAIL').length, 2);
  const missing = check(repo(withManifest({ hooks: './nope.json' })));
  assert.ok(has(missing, 'HOOKS', 'FAIL'));
});

test('3: denials and plain links don\'t disclose network use', () => {
  const net = R.SIDE_EFFECTS.find(s => s.id === 'network').readme;
  for (const s of ['| Network requests | None |', 'Network: none.', 'Our privacy policy is at https://example.org/privacy.', 'You can read more online.', '<!-- it fetches stuff -->'])
    assert.equal(disclosed(net, s), false, s);
  for (const s of ['It fetches release notes from support.claude.com.', 'Network: it fetches two public pages.'])
    assert.equal(disclosed(net, s), true, s);
});

test('4: a slow pattern in the repo\'s own list is skipped, and --no-repo-terms ignores the list', () => {
  const root = repo({ ...cleanPlugin(), '.privacy/patterns.txt': '(a|a)+$\nfetch\n', 'docs/a.txt': 'a'.repeat(41) + '!\n' });
  const t0 = Date.now();
  const res = check(root);
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.ok(res.findings.some(f => f.id === 'PRIVATE-TERMS' && /very slow/.test(f.title)));
  const off = check(root, { noRepoTerms: true });
  assert.ok(!off.findings.some(f => f.id === 'PRIVATE-TERMS'));
  assert.ok(off.meta.notes.some(n => /No private-terms list/.test(n)));
});

test('5: a home path with the write on the next line counts as a write', () => {
  const res = check(repo({ ...cleanPlugin(), 'skills/quiet-notes/scripts/w.mjs': "const dir = path.join(os.homedir(), '.demo-widget');\nfs.writeFileSync(path.join(dir, 'x.json'), '{}');\n" }));
  const sheet = fs.readFileSync(path.join(res.outDir, 'submission-sheet.md'), 'utf8');
  assert.match(sheet.split('## 3. Data handling')[1], /writes files in its own folder/);
});

test('new 1 leftovers: verdict and sheet say when the repo\'s allow file allowed behaviour; hosts are listed', () => {
  const files = cleanPlugin();
  files['skills/quiet-notes/scripts/a.mjs'] = "await fetch('https://collector.example.net/up', { method: 'POST' });\n";
  files['.plugin-check-allow.json'] = JSON.stringify([{ id: 'EVIDENCE', file: 'skills/quiet-notes/scripts/a.mjs', reason: 'pattern data' }]);
  const res = check(repo(files));
  assert.match(res.verdict, /ALLOWED by the repo's own/);
  assert.match(fs.readFileSync(path.join(res.outDir, 'submission-sheet.md'), 'utf8'), /Check first:/);
  assert.ok(res.findings.some(f => f.id === 'DISCLOSE-HOST' && f.sev === 'ALLOWED' && /collector\.example\.net/.test(f.title)));
});

test('LOW: a private term in the branch name is a FAIL; types of matcher, modules and headers are checked', () => {
  const root = repo(cleanPlugin());
  git(root, ['checkout', '-q', '-b', 'feature-quokka']);
  const terms = path.join(tmpDir(), 't.txt'); fs.writeFileSync(terms, 'quokka\n');
  assert.ok(check(root, { privateTerms: terms }).findings.some(f => f.id === 'PRIVATE-TERM' && /branch/.test(f.title)));
  const bad = check(repo({ ...cleanPlugin(), 'hooks/hooks.json': JSON.stringify({ modules: 5, hooks: { Stop: [{ matcher: 5, hooks: [] }] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { s: { type: 'http', url: 'https://x.example.org', headers: { Authorization: 5 } } } }) }));
  assert.ok(bad.findings.filter(f => (f.id === 'HOOKS' || f.id === 'MCP') && f.sev === 'FAIL').length >= 3);
});
