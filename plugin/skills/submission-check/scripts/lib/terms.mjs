// Private-term matching with a hard time limit.
//
// The patterns are regular expressions: the user's own list, or the checked repo's
// .privacy/patterns.txt. Some patterns can take exponential time on some text ((a+)+$, or several
// long bounded repeats in a row). Rather than reject patterns by their shape, which also turned
// away ordinary patterns, every match runs inside a vm context with a timeout. A pattern that
// runs out of time is switched off for the rest of the run and reported, and text that couldn't
// be redacted in time is withheld rather than printed.
import vm from 'node:vm';

const CTX = vm.createContext({});
const MAX_LINE = 4096;
export const BUDGET_MS = 1500;      // per pattern and per batch of texts

// [{ re, n, source, file }] -> the same objects, with timedOut flags set as the run goes.
export function prepare(list) { return list.map(t => ({ ...t, timedOut: false, re: new RegExp(t.re.source, t.re.flags.replace('g', '')) })); }

function inVm(code, vars, budget = BUDGET_MS) {
  Object.assign(CTX, vars);
  try { return { ok: true, value: vm.runInContext(code, CTX, { timeout: budget }) }; }
  catch (e) { if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false }; throw e; }
  finally { for (const k of Object.keys(vars)) delete CTX[k]; }
}

// Index of the first text the term matches (lines over 4096 characters are skipped), or -1.
export function firstMatch(t, texts) {
  if (t.timedOut || !texts.length) return -1;
  const r = inVm('texts.findIndex(s => s.length <= max && re.test(s))', { texts, re: t.re, max: MAX_LINE });
  if (!r.ok) { t.timedOut = true; return -1; }
  return r.value;
}

// Indices of every text the term matches.
export function allMatches(t, texts) {
  if (t.timedOut || !texts.length) return [];
  const r = inVm('texts.reduce((a, s, i) => (s.length <= max && re.test(s) ? (a.push(i), a) : a), [])', { texts, re: t.re, max: MAX_LINE });
  if (!r.ok) { t.timedOut = true; return []; }
  return r.value;
}

// Replaces matches of every term in s with «private term N». Returns null if it ran out of time.
export function redact(terms, s) {
  const live = terms.filter(t => !t.timedOut);
  if (!live.length || !s) return s;
  const r = inVm(`s.split('\\n').map(l => {
      if (l.length > max) return l.slice(0, 200) + ' …(long line not shown)';
      for (const t of ts) l = l.replace(new RegExp(t.re.source, 'gi'), '«private term ' + t.n + '»');
      return l;
    }).join('\\n')`, { s, ts: live, max: MAX_LINE });
  return r.ok ? r.value : null;
}
