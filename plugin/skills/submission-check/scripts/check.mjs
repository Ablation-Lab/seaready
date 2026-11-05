#!/usr/bin/env node
// Seaready submission check: checks a plugin repo before it goes to Anthropic's plugin directory.
//
//   node check.mjs <repo> [--plugin-path <dir>] [--ref <commit>] [--out <dir>] [--worktree]
//                  [--private-terms <file>] [--config-dir <dir>] [--no-validate] [--quiet]
//
// Reads the committed files through `git archive` in an isolated mirror (as GitHub would serve
// them; see lib/git.mjs), runs the checks, and writes report.md, report.json and
// submission-sheet.md to --out (default <repo>/.plugin-check, which gets its own .gitignore so it
// is never committed). It never changes the repo's files, never runs the repo's code, and makes
// no network requests.
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
import { makeRedactor, redactDeep, oneLine } from './lib/safety.mjs';

const RULES_DATE = '2026-11-05';
const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

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
  if (!/^[A-Za-z0-9._\/~^@{}-]+$/.test(o.ref) || o.ref.startsWith('-')) usage(`--ref "${o.ref}" has characters a git ref can't have`);
  if (o.worktree && o.ref !== 'HEAD') usage('--worktree checks the working tree, so it can\'t be combined with --ref');
  return o;
}

// Private terms: one extended regex per line, # comments (the privacy-check format).
// strict = the user passed the file: a broken pattern stops the run (fail loudly). Otherwise
// (the checked repo's own .privacy/patterns.txt) a broken pattern is reported and skipped.
function loadPrivateTerms(file, strict, F) {
  if (!file || !fs.existsSync(file)) return [];
  const terms = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return;
    const src = t.replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]').replace(/\[\[:alpha:\]\]/g, '[A-Za-z]').replace(/\[\[:digit:\]\]/g, '[0-9]');
    try { terms.push({ re: new RegExp(src, 'i'), n: i + 1, source: `line ${i + 1}`, file: path.basename(file) }); }
    catch (e) {
      if (strict) throw new Error(`private terms ${file} line ${i + 1} is not a valid pattern: ${e.message}`);
      F.add('WARN', 'PRIVATE-TERMS', `Pattern on line ${i + 1} of .privacy/patterns.txt is not valid, so it was skipped`, { detail: e.message.replace(/\/.*\//, '/…/') });
    }
  });
  if (!terms.length && strict) throw new Error(`private terms file ${file} has no patterns`);
  return terms;
}

function remoteInfo(repo) {
  const url = G.git(repo, ['remote', 'get-url', 'origin'], { allowFail: true })?.trim();
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/i);
  return { url: url.replace(/\/\/[^@/]+@/, '//'), ownerRepo: m ? m[1] : null };
}

function findPluginDir(files, given) {
  if (given != null) return given.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '');
  if (files.has('.claude-plugin/plugin.json')) return '';
  const mp = files.get('.claude-plugin/marketplace.json');
  if (mp) {
    try {
      const j = JSON.parse(stripBom(mp.data.toString('utf8')));
      for (const p of Array.isArray(j?.plugins) ? j.plugins : []) {
        if (typeof p?.source !== 'string') continue;
        const d = p.source.replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/+$/, '');
        if (files.has((d ? d + '/' : '') + '.claude-plugin/plugin.json')) return d;
      }
    } catch { /* reported later */ }
  }
  const found = [...files.keys()].filter(p => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p)).sort((a, b) => a.split('/').length - b.split('/').length);
  return found.length ? found[0].replace(/\/?\.claude-plugin\/plugin\.json$/, '') : '';
}

function findClaude() {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  // Absolute PATH entries only, so a claude in the current folder is never picked up.
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(d => d && path.isAbsolute(d)), path.join(os.homedir(), '.local', 'bin')];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  return null;
}

// Runs `claude plugin validate` on a temporary copy of the committed plugin folder.
function claudeValidate(files, pluginDir, F) {
  const exe = findClaude();
  if (!exe) { F.add('INFO', 'CLAUDE-VALIDATE', 'claude CLI not found; skipped `claude plugin validate`'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seaready-validate-'));
  try {
    const base = pluginDir ? pluginDir + '/' : '';
    const target = path.join(tmp, 'plugin');
    for (const [p, f] of files) {
      if (!p.startsWith(base)) continue;
      const dest = path.resolve(target, ...p.slice(base.length).split('/'));
      if (!dest.startsWith(target + path.sep)) continue;           // never write outside the copy
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.data); }
      catch (e) { F.add('INFO', 'CLAUDE-VALIDATE', 'A file couldn\'t be copied for `claude plugin validate`', { file: p, detail: e.code || e.message }); }
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE_')));
    let out = '', code = 0;
    try {
      const opts = { cwd: tmp, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
      if (/\.cmd$/i.test(exe)) {
        // A .cmd needs cmd.exe; quote both paths and refuse characters cmd would interpret.
        if (/["%^&|<>]/.test(exe + target)) throw Object.assign(new Error('path has characters cmd.exe would interpret'), { status: 1 });
        out = execFileSync('cmd.exe', ['/d', '/s', '/c', `""${exe}" plugin validate "${target}""`], { ...opts, windowsVerbatimArguments: true });
      } else out = execFileSync(exe, ['plugin', 'validate', target], opts);
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
    const key = `${f.sev}|${f.id}|${f.title}|${f.file || ''}|${f.mergeKey || ''}`;
    const prev = byKey.get(key);
    if (!prev) { const copy = { ...f, lines: f.line ? [f.line] : [] }; byKey.set(key, copy); out.push(copy); continue; }
    if (f.line && !prev.lines.includes(f.line)) prev.lines.push(f.line);
  }
  for (const f of out) {
    if (f.lines.length > 1) f.detail = `${f.detail ? f.detail + '\n' : ''}Lines: ${f.lines.slice(0, 15).join(', ')}${f.lines.length > 15 ? ` (+${f.lines.length - 15} more)` : ''}`;
    delete f.lines; delete f.mergeKey;
  }
  return out;
}

// .plugin-check-allow.json: [{ id, file?, match?, reason }]. The special id "EVIDENCE" (with a
// file) tells the README-versus-code check that a file holds pattern data, not behaviour.
function readAllow(files, F) {
  const f = files.get('.plugin-check-allow.json');
  if (!f) return [];
  let entries;
  try { entries = JSON.parse(stripBom(f.data.toString('utf8'))); } catch (e) { F.add('FAIL', 'ALLOW-FILE', '.plugin-check-allow.json is not valid JSON', { detail: e.message }); return []; }
  if (!Array.isArray(entries)) { F.add('FAIL', 'ALLOW-FILE', '.plugin-check-allow.json must be a list'); return []; }
  return entries.filter(e => {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) { F.add('WARN', 'ALLOW-FILE', 'Allow entry needs "id" and "reason"', { detail: JSON.stringify(e)?.slice(0, 200) }); return false; }
    return true;
  });
}

function applyAllow(entries, list, F) {
  for (const e of entries) {
    if (e.id === 'EVIDENCE') continue;
    let used = 0;
    for (const x of list) {
      if ((x.sev === 'FAIL' || x.sev === 'WARN') && x.id === e.id && (!e.file || x.file === e.file) && (!e.match || `${x.title} ${x.detail || ''}`.includes(e.match))) {
        x.was = x.sev; x.sev = 'ALLOWED'; x.allowedReason = e.reason; used++;
      }
    }
    if (!used) F.add('INFO', 'ALLOW-FILE', `Allow entry matched nothing: ${e.id}${e.file ? ' ' + e.file : ''}`);
  }
}

// Runs one group of checks; an unexpected error becomes a FAIL finding instead of ending the run.
function guard(F, name, fn, fallback) {
  try { return fn(); }
  catch (e) { F.add('FAIL', 'CHECK-ERROR', `The ${name} checks stopped on unexpected input`, { detail: `${e.message}\nThe rest of the report still ran. Usually a field has the wrong type (for example a number where text belongs).` }); return fallback; }
}

// The output folder must not be (or contain) a link, and the default one must not be committed.
function prepareOut(outDir, isDefault, repoRoot, tree) {
  if (isDefault && tree.some(e => e.path === '.plugin-check' || e.path.startsWith('.plugin-check/')))
    throw new Error('.plugin-check is committed in this repo; pass --out <folder> to write the report somewhere else');
  const chain = isDefault ? [outDir] : [];
  for (const p of chain) { try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a link; pass --out <folder>`); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  fs.mkdirSync(outDir, { recursive: true });
  if (fs.lstatSync(outDir).isSymbolicLink()) throw new Error(`${outDir} is a link; pass --out <folder>`);
  if (isDefault && !fs.realpathSync(outDir).startsWith(fs.realpathSync(repoRoot))) throw new Error(`${outDir} resolves outside the repo; pass --out <folder>`);
  return name => {
    const p = path.join(outDir, name);
    try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a link; refusing to write through it`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return p;
  };
}

export function run(opts) {
  const repoIn = path.resolve(opts.repo);
  if (!fs.existsSync(repoIn)) throw new Error(`no such folder: ${repoIn}`);
  if (!G.isRepo(repoIn)) throw new Error(`${repoIn} is not a git repository. The portal reads plugins from GitHub, so commit it first.`);
  const repoRoot = path.resolve(G.topLevel(repoIn));
  const commit = G.resolveRef(repoRoot, opts.ref);
  const mirror = G.makeMirror(repoRoot);
  try { return runWith(opts, repoRoot, commit, mirror); } finally { mirror.dispose(); }
}

function runWith(opts, repoRoot, commit, mirror) {
  const F = C.createFindings();
  const notes = [];
  const tree = G.lsTree(mirror, commit);
  const blobEntries = tree.filter(e => e.type === 'blob' && e.mode !== '120000');
  const blobs = G.catBlobs(mirror, blobEntries.map(e => e.sha));
  const blobsByPath = new Map(blobEntries.map(e => [e.path, e.sha]));
  const attributeTexts = new Map();
  for (const e of blobEntries) if (/(^|\/)\.gitattributes$/.test(e.path)) attributeTexts.set(e.path, blobs.get(e.sha).toString('utf8'));
  const gitDir = G.git(repoRoot, ['rev-parse', '--absolute-git-dir']).trim();
  const infoAttr = path.join(gitDir, 'info', 'attributes');
  if (fs.existsSync(infoAttr) && fs.readFileSync(infoAttr, 'utf8').replace(/#.*/g, '').trim())
    notes.push('This clone has its own .git/info/attributes. GitHub doesn\'t, so the archive check ignores it; your local checkouts may still differ.');
  // The GitHub-like archive is what the checks read.
  const tarBuf = G.archive(mirror, commit);
  let files = new Map(readTar(tarBuf).filter(e => e.type === 'file').map(e => [e.path, { data: e.data, mode: e.mode }]));
  const archiveFiles = files;
  // Working tree versus the commit, compared by reading the files (git diff could run a clean filter).
  const autocrlf = G.configGet(repoRoot, 'core.autocrlf'), eol = G.configGet(repoRoot, 'core.eol');
  const lfNorm = b => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  let worktreeDiff = 0;
  const dirty = [];
  const head = G.resolveRef(repoRoot, 'HEAD');
  if (head === commit) {
    for (const [p, sha] of blobsByPath) {
      let wt; try { const st = fs.lstatSync(path.join(repoRoot, ...p.split('/'))); if (!st.isFile()) continue; wt = fs.readFileSync(path.join(repoRoot, ...p.split('/'))); } catch { dirty.push(p); continue; }
      const b = blobs.get(sha);
      if (b.equals(wt)) continue;
      if (C.isText(wt) && lfNorm(wt).equals(lfNorm(b))) worktreeDiff++; else dirty.push(p);
    }
  }
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
  const identities = G.historyIdentities(mirror, commit);
  let addedLines = G.historyAddedLines(mirror, commit);
  if (addedLines == null) { F.add('WARN', 'HISTORY-SKIPPED', 'Couldn\'t read the full history, so earlier commits weren\'t checked for emails and private terms', { detail: 'The history is too large to read in one go. Check it with your own tools before the repo goes public.' }); addedLines = []; }
  const strictTerms = !!opts.privateTerms;
  const termsFile = opts.privateTerms || path.join(repoRoot, '.privacy', 'patterns.txt');
  const privateTerms = loadPrivateTerms(termsFile, strictTerms, F);
  if (privateTerms.length) notes.push(`Private terms: ${privateTerms.length} pattern(s) from ${strictTerms ? path.basename(termsFile) : '.privacy/patterns.txt'} (matches are never printed).`);
  else notes.push('No private-terms list (.privacy/patterns.txt or --private-terms), so names and other private words were not checked. Add one to catch your real name or project codenames.');
  const listings = loadListings(opts.configDir);
  const allow = readAllow(files, F);
  const ctx = {
    repoRoot, commit, tree, files, archiveFiles, blobs, blobsByPath, pluginDir, attributeTexts, archiveBytes: tarBuf.length,
    localConfig: { autocrlf, eol }, worktreeDiff, remote, ownRepoKey: remote?.ownerRepo ? `github.com/${remote.ownerRepo.toLowerCase()}` : null,
    listings, identities, addedLines, privateTerms, evidenceIgnore: new Set(allow.filter(e => e.id === 'EVIDENCE' && e.file).map(e => e.file)),
  };
  // Checks. Each group is guarded so malformed input becomes a finding, not a crash.
  guard(F, 'layout', () => C.checkLayout(ctx, F));
  guard(F, 'line-ending', () => C.checkLineEndings(ctx, F));
  const readme = guard(F, 'README', () => C.checkReadme(ctx, F), null);
  ctx.readme = readme;
  const mf = guard(F, 'manifest', () => C.checkManifest(ctx, F), {});
  ctx.manifest = mf.manifest;
  const components = guard(F, 'component', () => C.checkComponents(ctx, F), { skills: [], commands: [], agents: [] });
  const code = guard(F, 'code', () => C.checkCode(ctx, F, readme), { effects: [], hosts: [], envReads: [] });
  guard(F, 'Unicode', () => C.checkUnicode(ctx, F));
  guard(F, 'personal-data', () => C.checkPersonal(ctx, F));
  if (opts.validate) guard(F, 'claude plugin validate', () => claudeValidate(files, pluginDir, F));
  F.list.splice(0, F.list.length, ...consolidate(F.list));
  applyAllow(allow, F.list, F);
  // Redact every string that came from the repo before anything is written or printed.
  const redact = makeRedactor(privateTerms);
  const findings = F.list.map(f => ({ ...f, title: redact(f.title), detail: redact(f.detail), file: redact(f.file), allowedReason: redact(f.allowedReason) }));
  const manifest = mf.manifest && typeof mf.manifest === 'object' ? JSON.parse(JSON.stringify(mf.manifest)) : mf.manifest;
  if (manifest?.author && typeof manifest.author === 'object') delete manifest.author.email;
  const live = findings.filter(f => f.sev !== 'ALLOWED');
  const skillBodies = components.skills.map(s => s.fm?.body || '').join('\n');
  const facts = redactDeep({ ...mf, manifest, readme: readme ? { ...readme, text: undefined } : null, components: { ...components, skills: components.skills.map(s => ({ ...s, fm: undefined, scriptsHint: /\$\{CLAUDE_SKILL_DIR\}|\bnode\b|\bpowershell\b|\bpython3?\b|\bbash\b|\.ps1\b|\.sh\b/.test(s.fm?.body || '') })) },
    code, chat: live.filter(f => f.id === 'CHAT-HISTORY' && (f.sev === 'FAIL' || f.sev === 'WARN')),
    webTools: /\bWeb(Fetch|Search)\b|web (fetch|search)|search (GitHub|the web)/i.test(skillBodies), licenseFile: [...files.keys()].some(p => /(^|\/)LICEN[SC]E/i.test(p)) }, redact);
  const c = counts(findings);
  const meta = { repoRoot, repoName: path.basename(repoRoot), commit, ref: opts.ref, worktree: opts.worktree, pluginDir, pluginName: redact(manifest?.displayName || manifest?.name),
    rulesDate: RULES_DATE, notes, remote, branch, unpushed, date: new Date().toISOString().slice(0, 10), counts: c };
  const judgement = [
    'REQUIRED, every run: the name and overlap search. Search GitHub, the plugin directory (web) and the web, including community skill directories, for the plugin and skill names and for similar plugins; this script only saw the offline directory copy. Record sources, queries and results first in the Judgement section, with suggested "How it compares" text for the user to paste (never edit the repo).',
    'Policy 2B: does each skill/command description match what it really does, with no promised features it lacks?',
    'README vs code: read the scripts the skill tells Claude to run. Is every program started, file read or written (with its location), registry or shortcut change, and network request described in the README? Add anything missing as a FAIL.',
    'Does the README\'s Privacy section match the data-handling answers in the sheet?',
    'Policy 1G: if any CHAT-HISTORY finding fired, does the code read what was said in conversations (FAIL) or only list sessions/metadata (explain for reviewers)?',
    'Policy 2C: compare with the overlapping listings (OVERLAP) and make sure the README says how this one differs.',
    'Example prompts (3E): would each one work on the sample data as written?',
  ];
  const isDefault = !opts.out;
  const outDir = path.resolve(opts.out || path.join(repoRoot, '.plugin-check'));
  const outFile = prepareOut(outDir, isDefault, repoRoot, tree);
  if (isDefault) fs.writeFileSync(outFile('.gitignore'), '*\n');
  fs.writeFileSync(outFile('report.md'), renderReport(meta, findings, judgement));
  fs.writeFileSync(outFile('submission-sheet.md'), renderSheet(meta, facts));
  const json = { meta: { ...meta, remote: remote ? { ownerRepo: remote.ownerRepo } : null }, findings,
    facts: redactDeep({ manifest, prompts: readme?.prompts, effects: code.effects, hosts: code.hosts, envReads: code.envReads, skills: components.skills.map(s => ({ path: s.path, name: s.name, description: s.description })) }, redact) };
  fs.writeFileSync(outFile('report.json'), JSON.stringify(json, null, 2));
  return { outDir, counts: c, verdict: verdict(c), findings, meta };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  let res;
  try { res = run(opts); }
  catch (e) { console.error(`check: could not run: ${oneLine(e.message, 500)}`); process.exit(2); }
  const c = res.counts;
  console.log(`${res.verdict}\n${c.FAIL} FAIL, ${c.WARN} WARN, ${c.INFO} INFO, ${c.PASS} PASS${c.ALLOWED ? `, ${c.ALLOWED} ALLOWED` : ''}`);
  if (!opts.quiet) for (const f of res.findings.filter(x => x.sev === 'FAIL' || x.sev === 'WARN')) console.log(`${f.sev} [${f.id}] ${oneLine(f.title, 160)}${f.file ? `  (${oneLine(f.file, 120)}${f.line ? ':' + f.line : ''})` : ''}`);
  console.log(`Report: ${path.join(res.outDir, 'report.md')}\nSheet:  ${path.join(res.outDir, 'submission-sheet.md')}`);
  process.exit(c.FAIL ? 1 : 0);
}
