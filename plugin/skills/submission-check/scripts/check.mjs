#!/usr/bin/env node
// Tollgate submission check: checks a plugin repo before it goes to Anthropic's plugin directory.
//
//   node check.mjs <repo> [--plugin-path <dir>] [--ref <commit>] [--out <dir>] [--worktree]
//                  [--private-terms <file>] [--config-dir <dir>] [--no-validate] [--quiet]
//
// Reads the committed files through `git archive` (as GitHub would serve them), runs the checks,
// and writes report.md, report.json and submission-sheet.md to --out (default <repo>/.plugin-check,
// which gets its own .gitignore so it is never committed). It never changes the repo's files,
// never runs the repo's code, and makes no network requests.
// Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = the check itself couldn't run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from './lib/git.mjs';
import { readTar } from './lib/tar.mjs';
import * as C from './lib/checks.mjs';
import { loadListings } from './lib/directory.mjs';
import { renderReport, renderSheet, counts, verdict } from './lib/report.mjs';

const RULES_DATE = '2026-11-05';

function usage(msg) {
  if (msg) console.error(`check: ${msg}`);
  console.error('usage: node check.mjs <repo> [--plugin-path <dir>] [--ref <commit>] [--out <dir>] [--worktree] [--private-terms <file>] [--config-dir <dir>] [--no-validate] [--quiet]');
  process.exit(2);
}

export function parseArgs(argv) {
  const o = { repo: null, pluginPath: null, ref: 'HEAD', out: null, worktree: false, privateTerms: null, configDir: null, validate: true, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null || v.startsWith('--')) usage(`${a} needs a value`); return v; };
    if (a === '--plugin-path') o.pluginPath = val();
    else if (a === '--ref') o.ref = val();
    else if (a === '--out') o.out = val();
    else if (a === '--worktree') o.worktree = true;
    else if (a === '--private-terms') o.privateTerms = val();
    else if (a === '--config-dir') o.configDir = val();
    else if (a === '--no-validate') o.validate = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (!o.repo) o.repo = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!o.repo) usage('give the path of the plugin repo');
  if (!/^[A-Za-z0-9._\/~^@{}-]+$/.test(o.ref)) usage(`--ref "${o.ref}" has characters a git ref can't have`);
  return o;
}

// Private terms: one extended regex per line, # comments (the privacy-check format).
function loadPrivateTerms(file) {
  if (!file || !fs.existsSync(file)) return [];
  const terms = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return;
    const src = t.replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]').replace(/\[\[:alpha:\]\]/g, '[A-Za-z]').replace(/\[\[:digit:\]\]/g, '[0-9]');
    try { terms.push({ re: new RegExp(src, 'i'), n: i + 1, source: `line ${i + 1}`, file: path.basename(file) }); }
    catch (e) { throw new Error(`private terms ${file} line ${i + 1} is not a valid pattern: ${e.message}`); }
  });
  if (!terms.length) throw new Error(`private terms file ${file} has no patterns`);
  return terms;
}

function remoteInfo(repo) {
  const url = G.git(repo, ['remote', 'get-url', 'origin'], { allowFail: true })?.trim();
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/i);
  return { url: url.replace(/\/\/[^@/]+@/, '//'), ownerRepo: m ? m[1] : null };
}

function findPluginDir(files, given) {
  if (given != null) return given.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/$/, '');
  if (files.has('.claude-plugin/plugin.json')) return '';
  const mp = files.get('.claude-plugin/marketplace.json');
  if (mp) {
    try {
      const j = JSON.parse(mp.data.toString('utf8').replace(/^\uFEFF/, ''));
      for (const p of j.plugins || []) {
        if (typeof p.source !== 'string') continue;
        const d = p.source.replace(/^\.\/?/, '').replace(/\/$/, '');
        if (files.has((d ? d + '/' : '') + '.claude-plugin/plugin.json')) return d;
      }
    } catch { /* reported later */ }
  }
  const found = [...files.keys()].filter(p => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p)).sort((a, b) => a.split('/').length - b.split('/').length);
  return found.length ? found[0].replace(/\/?\.claude-plugin\/plugin\.json$/, '') : '';
}

function findClaude() {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

// Runs `claude plugin validate` on a temporary copy of the committed plugin folder.
function claudeValidate(files, pluginDir, F) {
  const exe = findClaude();
  if (!exe) { F.add('INFO', 'CLAUDE-VALIDATE', 'claude CLI not found; skipped `claude plugin validate`'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tollgate-'));
  try {
    const base = pluginDir ? pluginDir + '/' : '';
    const target = path.join(tmp, 'plugin');
    for (const [p, f] of files) {
      if (!p.startsWith(base)) continue;
      const dest = path.join(target, ...p.slice(base.length).split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
    let out = '', code = 0;
    try {
      out = execFileSync(exe, ['plugin', 'validate', target], { cwd: tmp, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: /\.cmd$/i.test(exe) });
    } catch (e) { code = e.status ?? 1; out = `${e.stdout || ''}${e.stderr || ''}` || e.message; }
    const text = out.replace(/\x1b\[[0-9;]*m/g, '').replaceAll(tmp, '<tmp>').trim();
    // Newer versions add "Advice (does not change the verdict)": keep it as INFO.
    const advice = text.split(/\n\s*\S*\s*Advice[^\n]*\n/)[1];
    if (advice) F.add('INFO', 'CLAUDE-VALIDATE', '`claude plugin validate` advice', { detail: advice.replace(/\n\s*✔ Validation passed\s*$/, '').trim().slice(0, 1500) });
    if (code === 0 && /passed/i.test(text) && !/warn/i.test(text)) F.add('PASS', 'CLAUDE-VALIDATE', '`claude plugin validate` passed', { detail: text.split('\n').filter(l => /✔|passed|found nothing/i.test(l)).slice(0, 3).join('\n') });
    else if (code === 0) F.add('WARN', 'CLAUDE-VALIDATE', '`claude plugin validate` passed with warnings', { detail: text.slice(0, 1500) });
    else F.add('FAIL', 'CLAUDE-VALIDATE', '`claude plugin validate` failed', { detail: text.slice(0, 1500), portal: 'Blocks (syntax and schema)' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Merges repeats of the same finding in the same file into one, listing every line.
export function consolidate(list) {
  const out = [], byKey = new Map();
  for (const f of list) {
    const key = `${f.sev}|${f.id}|${f.title}|${f.file || ''}`;
    const prev = byKey.get(key);
    if (!prev) { const copy = { ...f, lines: f.line ? [f.line] : [] }; byKey.set(key, copy); out.push(copy); continue; }
    if (f.line && !prev.lines.includes(f.line)) prev.lines.push(f.line);
  }
  for (const f of out) {
    if (f.lines.length > 1) f.detail = `${f.detail ? f.detail + '\n' : ''}Lines: ${f.lines.slice(0, 15).join(', ')}${f.lines.length > 15 ? ` (+${f.lines.length - 15} more)` : ''}`;
    delete f.lines;
  }
  return out;
}

function applyAllow(files, list, F) {
  const f = files.get('.plugin-check-allow.json');
  if (!f) return;
  let entries;
  try { entries = JSON.parse(f.data.toString('utf8')); } catch (e) { F.add('FAIL', 'ALLOW-FILE', '.plugin-check-allow.json is not valid JSON', { detail: e.message }); return; }
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e.id || !e.reason) { F.add('WARN', 'ALLOW-FILE', 'Allow entry needs "id" and "reason"', { detail: JSON.stringify(e) }); continue; }
    let used = 0;
    for (const x of list) {
      if ((x.sev === 'FAIL' || x.sev === 'WARN') && x.id === e.id && (!e.file || x.file === e.file) && (!e.match || `${x.title} ${x.detail || ''}`.includes(e.match))) {
        x.was = x.sev; x.sev = 'ALLOWED'; x.allowedReason = e.reason; used++;
      }
    }
    if (!used) F.add('INFO', 'ALLOW-FILE', `Allow entry matched nothing: ${e.id}${e.file ? ' ' + e.file : ''}`);
  }
}

export function run(opts) {
  const repoIn = path.resolve(opts.repo);
  if (!fs.existsSync(repoIn)) throw new Error(`no such folder: ${repoIn}`);
  if (!G.isRepo(repoIn)) throw new Error(`${repoIn} is not a git repository. The portal reads plugins from GitHub, so commit it first.`);
  const repoRoot = path.resolve(G.topLevel(repoIn));
  const commit = G.resolveRef(repoRoot, opts.ref);
  const F = C.createFindings();
  const notes = [];
  const tree = G.lsTree(repoRoot, commit);
  const blobEntries = tree.filter(e => e.type === 'blob' && e.mode !== '120000');
  const blobs = G.catBlobs(repoRoot, blobEntries.map(e => e.sha));
  const blobsByPath = new Map(blobEntries.map(e => [e.path, e.sha]));
  // Attributes: committed .gitattributes files, plus this clone's .git/info/attributes.
  const attributeTexts = new Map();
  for (const e of blobEntries) if (/(^|\/)\.gitattributes$/.test(e.path)) attributeTexts.set(e.path, blobs.get(e.sha).toString('utf8'));
  const gitDir = G.git(repoRoot, ['rev-parse', '--absolute-git-dir']).trim();
  const infoAttr = path.join(gitDir, 'info', 'attributes');
  const extraAttr = fs.existsSync(infoAttr) ? [fs.readFileSync(infoAttr, 'utf8')] : [];
  if (extraAttr[0]?.trim()) notes.push('.git/info/attributes in this clone also applies locally (GitHub doesn\'t have it).');
  const filters = G.filterNames([...attributeTexts.values(), ...extraAttr]);
  // The GitHub-like archive is what the checks read.
  const tarBuf = G.archive(repoRoot, commit, { filters });
  const entries = readTar(tarBuf);
  let files = new Map(entries.filter(e => e.type === 'file').map(e => [e.path, { data: e.data, mode: e.mode }]));
  const archiveFiles = files;
  // Local skew: archive with this machine's config, and the working tree vs the blobs.
  let localArchiveDiff = 0, worktreeDiff = 0;
  const localTar = readTar(G.archive(repoRoot, commit, { local: true, filters }));
  for (const e of localTar) if (e.type === 'file' && files.get(e.path) && !files.get(e.path).data.equals(e.data)) localArchiveDiff++;
  const head = G.resolveRef(repoRoot, 'HEAD');
  if (head === commit) {
    for (const [p, sha] of blobsByPath) {
      const fp = path.join(repoRoot, ...p.split('/'));
      let wt; try { wt = fs.readFileSync(fp); } catch { continue; }
      const b = blobs.get(sha);
      if (!b.equals(wt) && C.isText(wt) && Buffer.from(wt.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').equals(Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1'))) worktreeDiff++;
    }
  }
  const dirty = head === commit ? (G.git(repoRoot, ['diff', '--name-only', 'HEAD'], { allowFail: true }) || '').trim().split('\n').filter(Boolean) : [];
  const untracked = head === commit ? (G.git(repoRoot, ['ls-files', '-o', '--exclude-standard'], { allowFail: true }) || '').trim().split('\n').filter(Boolean).filter(p => !p.startsWith('.plugin-check/')) : [];
  if (opts.worktree) {
    files = new Map();
    for (const p of (G.git(repoRoot, ['ls-files', '-co', '--exclude-standard', '-z']) || '').split('\0').filter(Boolean)) {
      try { const st = fs.lstatSync(path.join(repoRoot, p)); if (st.isFile()) files.set(p, { data: fs.readFileSync(path.join(repoRoot, p)), mode: st.mode }); } catch { /* deleted */ }
    }
    notes.push('Working-tree mode: uncommitted and untracked files are included; the portal only sees what is pushed.');
  } else if (dirty.length || untracked.length) {
    F.add('WARN', 'GIT-DIRTY', 'Uncommitted changes are not in this report', { detail: `${dirty.length} changed, ${untracked.length} untracked (e.g. ${[...dirty, ...untracked].slice(0, 5).join(', ')}). The report checks the commit; the portal checks what is pushed. Run with --worktree to include them.` });
  }
  const pluginDir = findPluginDir(files, opts.pluginPath);
  if (pluginDir && ![...files.keys()].some(p => p.startsWith(pluginDir + '/'))) throw new Error(`plugin path "${pluginDir}" has no committed files in ${commit.slice(0, 7)}`);
  // Git facts.
  const remote = remoteInfo(repoRoot);
  const branch = G.git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true })?.trim() || null;
  let unpushed = 0;
  if (!remote) F.add('WARN', 'GIT-REMOTE', 'No "origin" remote', { detail: 'The portal reads the plugin from GitHub. Create the repo (it can stay private while you validate and submit) and push.' });
  else if (!remote.ownerRepo) F.add('WARN', 'GIT-REMOTE', 'origin is not a github.com repository', { detail: remote.url });
  else if (branch) {
    const n = G.git(repoRoot, ['rev-list', '--count', `origin/${branch}..${commit}`], { allowFail: true });
    if (n == null) F.add('INFO', 'GIT-REMOTE', `No origin/${branch} yet (not pushed, or not fetched)`);
    else if (Number(n) > 0) { unpushed = Number(n); F.add('WARN', 'GIT-UNPUSHED', `${n} commit(s) not pushed to origin/${branch}`, { detail: 'The portal validates what is on GitHub.' }); }
  }
  const identities = G.historyIdentities(repoRoot, commit);
  const addedLines = G.historyAddedLines(repoRoot, commit);
  const termsFile = opts.privateTerms || path.join(repoRoot, '.privacy', 'patterns.txt');
  const privateTerms = loadPrivateTerms(termsFile);
  if (privateTerms.length) notes.push(`Private terms: ${privateTerms.length} pattern(s) from ${opts.privateTerms ? path.basename(termsFile) : '.privacy/patterns.txt'} (never printed).`);
  else notes.push('No private-terms list (.privacy/patterns.txt or --private-terms), so names and other private words were not checked. Add one to catch your real name or project codenames.');
  const listings = loadListings(opts.configDir);
  const ctx = {
    repoRoot, commit, tree, files, archiveFiles, blobs, blobsByPath, pluginDir, attributeTexts, archiveBytes: tarBuf.length,
    localConfig: { autocrlf: G.configGet(repoRoot, 'core.autocrlf'), eol: G.configGet(repoRoot, 'core.eol') },
    localArchiveDiff, worktreeDiff, remote, ownRepoKey: remote?.ownerRepo ? `github.com/${remote.ownerRepo.toLowerCase()}` : null,
    listings, identities, addedLines, privateTerms,
  };
  // Checks.
  C.checkLayout(ctx, F);
  C.checkLineEndings(ctx, F);
  const readme = C.checkReadme(ctx, F);
  ctx.readme = readme;
  const mf = C.checkManifest(ctx, F);
  ctx.manifest = mf.manifest;
  const components = C.checkComponents(ctx, F);
  const code = C.checkCode(ctx, F, readme);
  C.checkUnicode(ctx, F);
  C.checkPersonal(ctx, F);
  if (opts.validate) claudeValidate(files, pluginDir, F);
  F.list.splice(0, F.list.length, ...consolidate(F.list));
  applyAllow(files, F.list, F);
  // Output.
  const skillBodies = components.skills.map(s => s.fm?.body || '').join('\n');
  const facts = { ...mf, readme, components, code, chat: F.list.filter(f => f.id === 'CHAT-HISTORY' && f.sev !== 'PASS'),
    webTools: /\bWeb(Fetch|Search)\b|web (fetch|search)/i.test(skillBodies), licenseFile: [...files.keys()].some(p => /(^|\/)LICEN[SC]E/i.test(p)) };
  const c = counts(F.list);
  const meta = { repoRoot, repoName: path.basename(repoRoot), commit, ref: opts.ref, worktree: opts.worktree, pluginDir, pluginName: mf.manifest?.displayName || mf.manifest?.name,
    rulesDate: RULES_DATE, notes, remote, branch, unpushed, date: new Date().toISOString().slice(0, 10), counts: c };
  const judgement = [
    'Policy 2B: does each skill/command description match what it really does, with no promised features it lacks?',
    'README vs code: read the scripts the skill tells Claude to run. Is every program started, file read or written (with its location), registry or shortcut change, and network request described in the README? Add anything missing as a FAIL.',
    'Does the README\'s Privacy section match the data-handling answers in the sheet?',
    'Policy 1G: if any CHAT-HISTORY finding fired, does the code read what was said in conversations (FAIL) or only list sessions/metadata (explain for reviewers)?',
    'Policy 2C: compare with the overlapping listings (OVERLAP) and make sure the README says how this one differs.',
    'Example prompts (3E): would each one work on the sample data as written?',
  ];
  const outDir = path.resolve(opts.out || path.join(repoRoot, '.plugin-check'));
  fs.mkdirSync(outDir, { recursive: true });
  if (!opts.out) fs.writeFileSync(path.join(outDir, '.gitignore'), '*\n');
  const report = renderReport(meta, F.list, judgement);
  const sheet = renderSheet(meta, facts);
  fs.writeFileSync(path.join(outDir, 'report.md'), report);
  fs.writeFileSync(path.join(outDir, 'submission-sheet.md'), sheet);
  const json = { meta: { ...meta, remote: remote ? { ownerRepo: remote.ownerRepo } : null }, findings: F.list,
    facts: { manifest: mf.manifest, prompts: readme?.prompts, effects: code.effects, hosts: code.hosts, envReads: code.envReads, skills: components.skills.map(s => ({ path: s.path, name: s.name, description: s.description })) } };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(json, null, 2));
  return { outDir, counts: c, verdict: verdict(c), findings: F.list, meta };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  let res;
  try { res = run(opts); }
  catch (e) { console.error(`check: could not run: ${e.message}`); process.exit(2); }
  const c = res.counts;
  console.log(`${res.verdict}\n${c.FAIL} FAIL, ${c.WARN} WARN, ${c.INFO} INFO, ${c.PASS} PASS${c.ALLOWED ? `, ${c.ALLOWED} ALLOWED` : ''}`);
  if (!opts.quiet) for (const f of res.findings.filter(x => x.sev === 'FAIL' || x.sev === 'WARN')) console.log(`${f.sev} [${f.id}] ${f.title}${f.file ? `  (${f.file}${f.line ? ':' + f.line : ''})` : ''}`);
  console.log(`Report: ${path.join(res.outDir, 'report.md')}\nSheet:  ${path.join(res.outDir, 'submission-sheet.md')}`);
  process.exit(c.FAIL ? 1 : 0);
}
