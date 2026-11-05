// Text from the checked repo is untrusted. Everything the checker prints passes through here:
//   - redaction: personal email addresses are masked and the user's private terms replaced,
//     in every finding and in report.json;
//   - rendering: newlines, control, bidirectional and invisible characters are shown as visible
//     codes, Markdown punctuation is escaped in headings, table cells and titles, and quoted
//     repo text goes in code blocks fenced longer than any backtick run inside it. So a plugin
//     name or a line of its code can't add headings, sections or instructions to the report.
import { EMAIL, SAFE_EMAIL } from './rules.mjs';
import { redact as redactTerms } from './terms.mjs';

const MAX_LINE = 4096;

export const maskEmail = e => { const at = e.indexOf('@'); return `${e.slice(0, Math.min(2, at))}…${e.slice(at)}`; };

// terms come from lib/terms.mjs prepare(); their matching runs under a time limit there, and a
// timeout stops the whole check (TermTimeout) before anything is written.
export function makeRedactor(terms = []) {
  return s => {
    if (typeof s !== 'string' || !s) return s;
    const out = s.replace(EMAIL, e => (SAFE_EMAIL.test(e) ? e : maskEmail(e)));
    if (!terms.length) return out.split('\n').map(l => (l.length > MAX_LINE ? l.slice(0, 200) + ' …(long line not shown)' : l)).join('\n');
    return redactTerms(terms, out);
  };
}

export function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, redact);
    return out;
  }
  return value;
}

// Characters that move, hide or break text: shown as ⟨U+XXXX⟩.
const INVISIBLE_RANGES = [[0x0, 0x8], [0xB, 0xC], [0xE, 0x1F], [0x7F, 0x9F], [0xAD, 0xAD], [0x61C, 0x61C], [0x115F, 0x1160], [0x180E, 0x180E],
  [0x200B, 0x200F], [0x2028, 0x202E], [0x2060, 0x2069], [0x3164, 0x3164], [0xFE00, 0xFE0F], [0xFEFF, 0xFEFF], [0xFFA0, 0xFFA0],
  [0xE0000, 0xE007F], [0xE0100, 0xE01EF]];
const isInvisible = cp => INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);
const visible = s => Array.from(s, c => { const cp = c.codePointAt(0); return isInvisible(cp) ? `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩` : c; }).join("");

// One line, visible codes for hidden characters, length cap.
export function oneLine(s, max = 300) {
  let t = visible(String(s ?? '').replace(/\r\n|\r|\n/g, ' ⏎ ').replace(/\t/g, ' '));
  if (t.length > max) t = t.slice(0, max) + '…';
  return t;
}

// For Markdown headings, list titles and table cells.
export function mdInline(s, max = 300) {
  // & too, so an HTML entity such as &rlm; can't render as an invisible character.
  return oneLine(s, max).replace(/[\\`*_[\]<>|#~&]/g, c => '\\' + c);
}

// A fenced code block that the content can't close early. indent is added to every line.
export function fence(text, indent = '', info = 'text') {
  const lines = visible(String(text ?? '').replace(/\r\n|\r/g, '\n')).split('\n').map(l => (l.length > 1000 ? l.slice(0, 1000) + '…' : l));
  const longest = Math.max(0, ...lines.map(l => Math.max(0, ...(l.match(/`+/g) || []).map(r => r.length))));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return [`${indent}${f}${info}`, ...lines.map(l => indent + l), `${indent}${f}`].join('\n');
}
