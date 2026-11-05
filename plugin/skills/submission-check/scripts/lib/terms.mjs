// Private-term matching with a hard time limit, failing closed.
//
// The patterns are regular expressions: the user's own list, or the checked repo's
// .privacy/patterns.txt. Some patterns can take exponential time on some text ((a+)+$, or several
// long bounded repeats in a row). Every match runs inside a vm context with a timeout, on chunks of
// at most CHUNK texts, so ordinary patterns on a large history still finish well inside it.
//
// If a pattern runs out of time anywhere, while finding matches or while redacting, the whole
// check stops before anything is written, with a message naming the pattern's line. Switching the
// pattern off and carrying on would mean text it should have hidden gets printed.
import vm from 'node:vm';

const CTX = vm.createContext({});
const MAX_LINE = 4096;
const CHUNK = 2000;
export const BUDGET_MS = 1500;      // per pattern, per chunk of texts or per redacted string

export class TermTimeout extends Error {
  constructor(t) {
    super(`private-terms pattern on ${t.source} of ${t.file} took longer than ${BUDGET_MS / 1000} s on some text, so the check stopped before writing anything (a slow pattern could otherwise leave text unredacted). Rewrite that pattern more simply (for example without a repeated group like (a+)+), or, for a repo that isn't yours, run with --no-repo-terms.`);
    this.term = t;
  }
}

export function prepare(list) { return list.map(t => ({ ...t, re: new RegExp(t.re.source, t.re.flags.replace('g', '')) })); }

function inVm(t, code, vars) {
  Object.assign(CTX, vars);
  try { return vm.runInContext(code, CTX, { timeout: BUDGET_MS }); }
  catch (e) { if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new TermTimeout(t); throw e; }
  finally { for (const k of Object.keys(vars)) delete CTX[k]; }
}

// Index of the first text the term matches (texts over 4096 characters are skipped), or -1.
export function firstMatch(t, texts) {
  for (let start = 0; start < texts.length; start += CHUNK) {
    const k = inVm(t, 'texts.findIndex(s => s.length <= max && re.test(s))', { texts: texts.slice(start, start + CHUNK), re: t.re, max: MAX_LINE });
    if (k >= 0) return start + k;
  }
  return -1;
}

// Indices of every text the term matches.
export function allMatches(t, texts) {
  const out = [];
  for (let start = 0; start < texts.length; start += CHUNK) {
    const hits = inVm(t, 'texts.reduce((a, s, i) => (s.length <= max && re.test(s) ? (a.push(i), a) : a), [])', { texts: texts.slice(start, start + CHUNK), re: t.re, max: MAX_LINE });
    for (const k of hits) out.push(start + k);
  }
  return out;
}

// Replaces matches of every term in s with «private term N», one term at a time.
export function redact(terms, s) {
  if (!terms.length || !s) return s;
  let out = s.split('\n').map(l => (l.length > MAX_LINE ? l.slice(0, 200) + ' …(long line not shown)' : l)).join('\n');
  for (const t of terms) out = inVm(t, `s.replace(new RegExp(re.source, 'gi'), '«private term ' + n + '»')`, { s: out, re: t.re, n: t.n });
  return out;
}
