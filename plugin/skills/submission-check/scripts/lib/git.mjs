// Read-only git access for the checker.
//
// Every call goes through execFileSync with an argument array (no shell), so paths and refs
// from the repo under test can't inject commands. Each call also neutralises the config that
// could make git run a program from the checked repo or this machine:
//   - core.fsmonitor (only the read commands below are used, so no hooks fire),
//   - core.attributesFile (GitHub's servers don't have this machine's global attributes),
//   - any filter driver named in the repo's .gitattributes (its smudge is replaced with "cat").
import { execFileSync } from 'node:child_process';

const BASE = ['-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=',
  '-c', 'protocol.allow=never', '-c', 'core.quotePath=false'];

export class GitError extends Error {}

export function git(repo, args, { encoding = 'utf8', extra = [], allowFail = false, input } = {}) {
  try {
    return execFileSync('git', ['-C', repo, ...BASE, ...extra, ...args], {
      encoding: encoding === 'buffer' ? undefined : 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
      windowsHide: true,
    });
  } catch (e) {
    if (allowFail) return null;
    const msg = (e.stderr ? e.stderr.toString() : e.message).trim();
    throw new GitError(`git ${args.join(' ')} failed: ${msg}`);
  }
}

export function isRepo(repo) {
  return git(repo, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true';
}

export function topLevel(repo) {
  return git(repo, ['rev-parse', '--show-toplevel']).trim();
}

export function resolveRef(repo, ref) {
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

export function configGet(repo, key) {
  const v = git(repo, ['config', '--get', key], { allowFail: true });
  return v == null ? null : v.trim();
}

// Lists the tree at a commit: [{ mode, type, sha, size, path }].
export function lsTree(repo, commit) {
  const out = git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], { encoding: 'buffer' });
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
export function catBlobs(repo, shas) {
  const result = new Map();
  const unique = [...new Set(shas)];
  if (!unique.length) return result;
  const out = git(repo, ['cat-file', '--batch'], { encoding: 'buffer', input: unique.join('\n') + '\n' });
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) break;
    const header = out.slice(pos, nl).toString('utf8');
    const parts = header.split(' ');
    if (parts[1] === 'missing') { pos = nl + 1; continue; }
    const size = Number(parts[2]);
    result.set(parts[0], out.subarray(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return result;
}

// Filter drivers named in attributes, so archive can neutralise them.
export function filterNames(attributeTexts) {
  const names = new Set();
  for (const t of attributeTexts) for (const m of t.matchAll(/(?:^|\s)filter=([A-Za-z0-9._-]+)/g)) names.add(m[1]);
  return [...names];
}

// git archive of a commit as a tar Buffer, with GitHub-like settings (autocrlf off, eol lf)
// unless local=true, which uses this machine's own config (to show local skew).
export function archive(repo, commit, { local = false, filters = [] } = {}) {
  const extra = [];
  if (!local) extra.push('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false');
  for (const f of filters) {
    extra.push('-c', `filter.${f}.smudge=cat`, '-c', `filter.${f}.process=`, '-c', `filter.${f}.required=false`);
  }
  return git(repo, ['archive', '--format=tar', commit], { encoding: 'buffer', extra });
}

// Author, committer and co-author emails across all history reachable from the commit.
export function historyIdentities(repo, commit) {
  const out = git(repo, ['log', '--format=%H%x1f%ae%x1f%ce%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e)%x1d', commit]);
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

// Every line added anywhere in history reachable from the commit (for leaks removed later).
export function historyAddedLines(repo, commit) {
  const out = git(repo, ['log', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '--format=commit %H', '--unified=0', commit],
    { allowFail: true });
  if (out == null) return [];
  const lines = [];
  let sha = '', file = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('commit ')) sha = line.slice(7, 19);
    else if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('+') && !line.startsWith('+++')) lines.push({ sha, file, text: line.slice(1) });
  }
  return lines;
}

export function commitSubjects(repo, commit) {
  const out = git(repo, ['log', '--format=%h%x1f%s', commit], { allowFail: true }) || '';
  return out.split('\n').filter(Boolean).map(l => { const [h, s] = l.split('\x1f'); return { sha: h, subject: s }; });
}
