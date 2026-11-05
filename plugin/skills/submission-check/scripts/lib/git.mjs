// Read-only git access for the checker.
//
// A checked repo can arrive with its own .git folder (a zip, a shared folder), and that folder's
// config can name programs (filter drivers, gpg.program, fsmonitor). So the checker splits git
// work in two:
//   - In a MIRROR: a new, empty bare repo in the temp folder whose only link to the checked repo
//     is objects/info/alternates (it borrows the objects, read only). It has no config, hooks,
//     attributes or refs of its own, and runs with system and global config switched off. All
//     content is read here: ls-tree, cat-file, archive, log. That is also what makes the archive
//     match GitHub's: only the committed .gitattributes apply.
//   - In the checked repo itself, only commands that read refs and config values and start no
//     other program: rev-parse, symbolic-ref, rev-list --count, config --get, remote get-url,
//     ls-files. Those also get core.fsmonitor=false, gpg.program and signature display off.
// Every call uses execFileSync with an argument list (no shell), and runs in an empty temp
// folder so a git.exe planted in the current folder is never picked up on Windows.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every transport protocol is switched off by name as well as in general: a repo's own
// protocol.<name>.allow outranks protocol.allow, but command-line settings outrank the repo's.
const PROTOCOLS = ['ext', 'file', 'ssh', 'git', 'http', 'https', 'fd'].flatMap(p => ['-c', `protocol.${p}.allow=never`]);
const BASE = ['-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=', '-c', 'protocol.allow=never', ...PROTOCOLS, '-c', 'core.quotePath=false',
  '-c', 'log.showSignature=false', '-c', 'gpg.program=false', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null')];
// No lazy fetch of missing objects (a partial clone's promisor remote could name any program),
// and never a credential or password prompt.
const SAFE_ENV = { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };

export class GitError extends Error {}

let safeCwd = null;
// Every temporary folder this process made and hasn't removed yet (the empty working folder and any
// mirrors). removeTemp() deletes them; check.mjs calls it when a run finishes or fails, and on exit.
const liveTemp = new Set();
export function removeTemp() {
  for (const d of liveTemp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } liveTemp.delete(d); }
  safeCwd = null;
}
process.on('exit', removeTemp);
// Ctrl+C and termination signals: remove the folders, then exit as the signal would. (A process killed
// outright, as Task Manager or a closed console does, runs no handler at all.)
export function removeTempOnSignals() {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129], ['SIGBREAK', 149]]) {
    try { process.on(sig, () => { removeTemp(); process.exit(code); }); } catch { /* signal not supported here */ }
  }
}
// An empty folder to run child processes in.
export function emptyCwd() {
  if (!safeCwd || !fs.existsSync(safeCwd)) { safeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seaready-cwd-')); liveTemp.add(safeCwd); }
  return safeCwd;
}

// Git 2.44 or later is required: --no-lazy-fetch (and GIT_NO_LAZY_FETCH) only exist from 2.44,
// and without them a partial clone's promisor remote can start a program named in the repo's
// config. Older git refuses the option outright, so it fails safe rather than running anything.
export const MIN_GIT = [2, 44];
export function parseGitVersion(text) {
  const m = String(text).match(/git version (\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
let versionChecked = false;
export function checkGitVersion() {
  if (versionChecked) return;
  let out;
  try { out = execFileSync('git', ['--version'], { encoding: 'utf8', cwd: emptyCwd(), windowsHide: true }); }
  catch (e) { throw new GitError(`git was not found (${e.code || e.message}); install git ${MIN_GIT.join('.')} or later`); }
  const v = parseGitVersion(out);
  if (!v || v[0] < MIN_GIT[0] || (v[0] === MIN_GIT[0] && v[1] < MIN_GIT[1]))
    throw new GitError(`${out.trim()} is too old: Seaready needs git ${MIN_GIT.join('.')} or later to read a repo without letting its config start programs`);
  versionChecked = true;
}

function run(args, { encoding = 'utf8', allowFail = false, input, env } = {}) {
  checkGitVersion();
  try {
    return execFileSync('git', ['--no-lazy-fetch', ...args], {
      encoding: encoding === 'buffer' ? undefined : 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      input, env: { ...(env || process.env), ...SAFE_ENV }, cwd: emptyCwd(), windowsHide: true,
    });
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr ? e.stderr.toString() : e.message).trim();
    throw new GitError(`git ${args.filter(a => !a.startsWith('core.') && a !== '-c').slice(-4).join(' ')} failed: ${msg.slice(0, 300)}`);
  }
}

// Commands in the checked repo (refs and config values only).
export function git(repo, args, opts = {}) {
  return run(['-C', repo, ...BASE, ...args], opts);
}

export function isRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';
}
export function topLevel(repo) { return git(repo, ['rev-parse', '--show-toplevel']).trim(); }
export function resolveRef(repo, ref) { return git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim(); }
export function configGet(repo, key) {
  const v = git(repo, ['config', '--get', key], { allowFail: true });
  return v == null ? null : v.trim();
}

// --- The mirror -----------------------------------------------------------------------------
export function makeMirror(repo) {
  const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
  const objects = path.join(common, 'objects');
  if (!fs.existsSync(objects)) throw new GitError(`no objects folder at ${objects}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seaready-mirror-'));
  liveTemp.add(dir);
  const gitDir = path.join(dir, 'm.git');
  const emptyConfig = path.join(dir, 'empty-config');
  fs.writeFileSync(emptyConfig, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|NAMESPACE|EXTERNAL_DIFF|PAGER|EDITOR|SSH|SSH_COMMAND|ASKPASS)$/.test(k)) delete env[k];
  run(['init', '--bare', '-q', '--template=', gitDir], { env });
  fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), objects.replace(/\\/g, '/') + '\n');
  // A shallow clone's boundary, so history walks stop where the objects stop.
  const shallow = path.join(common, 'shallow');
  if (fs.existsSync(shallow)) fs.copyFileSync(shallow, path.join(gitDir, 'shallow'));
  return {
    dir, gitDir,
    git: (args, opts = {}) => run(['--git-dir', gitDir, ...BASE, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false', ...args], { ...opts, env }),
    dispose: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder; ignore */ } if (!fs.existsSync(dir)) liveTemp.delete(dir); },
  };
}

// Lists the tree at a commit, folders included: [{ mode, type, sha, size, path }].
export function lsTree(m, commit) {
  const out = m.git(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit], { encoding: 'buffer' });
  const entries = [];
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, sha, size] = rec.slice(0, tab).trim().split(/\s+/);
    entries.push({ mode, type, sha, size: size === '-' ? 0 : Number(size), path: rec.slice(tab + 1) });
  }
  return entries;
}

// Reads many blobs at once. Returns Map<sha, Buffer>.
export function catBlobs(m, shas) {
  const result = new Map();
  const unique = [...new Set(shas)];
  if (!unique.length) return result;
  const out = m.git(['cat-file', '--batch'], { encoding: 'buffer', input: unique.join('\n') + '\n' });
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) break;
    const parts = out.slice(pos, nl).toString('utf8').split(' ');
    if (parts[1] === 'missing') { pos = nl + 1; continue; }
    const size = Number(parts[2]);
    result.set(parts[0], out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return result;
}

// git archive of a commit as a tar Buffer, with GitHub-like settings and only committed attributes.
export function archive(m, commit) {
  return m.git(['archive', '--format=tar', commit], { encoding: 'buffer' });
}

// Author, committer and co-author emails across all history reachable from the commit.
export function historyIdentities(m, commit) {
  const out = m.git(['log', '--no-show-signature', '--format=%H%x1f%ae%x1f%ce%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)%x1d', commit]);
  const rows = [];
  for (const rec of out.split('\x1d')) {
    const r = rec.trim();
    if (!r) continue;
    const [sha, ae, ce, co] = r.split('\x1f');
    const coEmails = (co || '').split('\x1e').map(s => (s.match(/<([^>]+)>/) || [])[1]).filter(Boolean);
    rows.push({ sha, author: ae, committer: ce, coAuthors: coEmails });
  }
  return rows;
}

// Commit messages (subject and body) across history: [{ sha, text }].
export function historyMessages(m, commit) {
  const out = m.git(['log', '--no-show-signature', '--format=%h%x1f%B%x1d', commit], { allowFail: true }) || '';
  return out.split('\x1d').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => { const [sha, text] = r.split('\x1f'); return { sha, text: text || '' }; });
}

// Every line added anywhere in history reachable from the commit (for leaks removed later).
// Returns null when git can't produce it (e.g. history too large for the buffer), so the caller
// can say the history scan was skipped instead of passing silently.
export function historyAddedLines(m, commit) {
  const out = m.git(['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--format=%x00commit %H', '--unified=0', commit], { allowFail: true });
  if (out == null) return null;
  const lines = [];
  let sha = '', file = '', inHeader = false;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0commit ')) { sha = line.slice(8, 20); inHeader = false; continue; }
    if (line.startsWith('diff --git ')) { inHeader = true; continue; }
    if (inHeader) {
      if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
      if (line.startsWith('@@')) inHeader = false;
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+')) lines.push({ sha, file, text: line.slice(1) });
  }
  return lines;
}
