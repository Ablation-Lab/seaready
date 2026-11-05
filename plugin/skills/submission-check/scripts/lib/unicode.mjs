// Finds hidden or unusual Unicode characters in text. Every character this file looks for is
// written as a \u escape, so the file itself contains none of them.

const NAMES = {
  0x00A0: 'NO-BREAK SPACE', 0x00AD: 'SOFT HYPHEN', 0x034F: 'COMBINING GRAPHEME JOINER',
  0x061C: 'ARABIC LETTER MARK', 0x115F: 'HANGUL CHOSEONG FILLER', 0x1160: 'HANGUL JUNGSEONG FILLER',
  0x180E: 'MONGOLIAN VOWEL SEPARATOR', 0x200B: 'ZERO WIDTH SPACE', 0x200C: 'ZERO WIDTH NON-JOINER',
  0x200D: 'ZERO WIDTH JOINER', 0x200E: 'LEFT-TO-RIGHT MARK', 0x200F: 'RIGHT-TO-LEFT MARK',
  0x2028: 'LINE SEPARATOR', 0x2029: 'PARAGRAPH SEPARATOR', 0x202A: 'LEFT-TO-RIGHT EMBEDDING',
  0x202B: 'RIGHT-TO-LEFT EMBEDDING', 0x202C: 'POP DIRECTIONAL FORMATTING', 0x202D: 'LEFT-TO-RIGHT OVERRIDE',
  0x202E: 'RIGHT-TO-LEFT OVERRIDE', 0x202F: 'NARROW NO-BREAK SPACE', 0x205F: 'MEDIUM MATHEMATICAL SPACE',
  0x2060: 'WORD JOINER', 0x2061: 'FUNCTION APPLICATION', 0x2062: 'INVISIBLE TIMES', 0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS', 0x2066: 'LEFT-TO-RIGHT ISOLATE', 0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE', 0x2069: 'POP DIRECTIONAL ISOLATE', 0x3000: 'IDEOGRAPHIC SPACE',
  0x3164: 'HANGUL FILLER', 0xFEFF: 'BYTE ORDER MARK / ZERO WIDTH NO-BREAK SPACE', 0xFFA0: 'HALFWIDTH HANGUL FILLER',
  0xFFFC: 'OBJECT REPLACEMENT CHARACTER', 0xFFFD: 'REPLACEMENT CHARACTER',
};

const hex = cp => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
export function cpName(cp) {
  if (NAMES[cp]) return NAMES[cp];
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'TAG CHARACTER';
  if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) return 'VARIATION SELECTOR';
  if (cp < 0x20 || cp === 0x7F) return 'CONTROL CHARACTER';
  if (cp >= 0x80 && cp <= 0x9F) return 'C1 CONTROL CHARACTER';
  if ((cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) return 'PRIVATE USE CHARACTER';
  if (cp >= 0x2000 && cp <= 0x200A) return 'SPACE (typographic width)';
  return 'CHARACTER';
}

// Classification: 'hidden' = invisible and able to hide or reorder text (always serious),
// 'odd' = visible-ish but unusual (worth a look).
export function classify(cp, prev, next, index) {
  if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return null;
  if (cp < 0x20 || cp === 0x7F || (cp >= 0x80 && cp <= 0x9F)) return 'hidden';
  if ((cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200E || cp === 0x200F || cp === 0x061C) return 'hidden';
  if (cp >= 0xE0000 && cp <= 0xE007F) return 'hidden';
  if (cp >= 0xE0100 && cp <= 0xE01EF) return 'hidden';
  if (cp >= 0xFE00 && cp <= 0xFE0F) {
    // VS15/VS16 after an emoji-capable symbol is normal.
    if ((cp === 0xFE0F || cp === 0xFE0E) && prev != null && isEmojiBase(prev)) return null;
    return 'hidden';
  }
  if (cp === 0xFEFF) return index === 0 ? null : 'hidden';
  if (cp === 0x200D) {
    // ZWJ between two emoji is how emoji sequences are built.
    if (prev != null && next != null && isEmojiBase(prev) && isEmojiBase(next)) return null;
    return 'hidden';
  }
  if (cp === 0x200B || cp === 0x200C || cp === 0x2060 || (cp >= 0x2061 && cp <= 0x2064) || cp === 0x180E ||
      cp === 0x034F || cp === 0x115F || cp === 0x1160 || cp === 0x3164 || cp === 0xFFA0) return 'hidden';
  if (cp === 0x2028 || cp === 0x2029) return 'odd';
  if ((cp >= 0xE000 && cp <= 0xF8FF) || cp >= 0xF0000) return 'odd';
  if (cp === 0x00A0 || cp === 0x00AD || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x202F || cp === 0x205F || cp === 0x3000) return 'odd';
  if (cp === 0xFFFC || cp === 0xFFFD) return 'odd';
  return null;
}

function isEmojiBase(cp) {
  return (cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2190 && cp <= 0x21FF) ||
    (cp >= 0x2300 && cp <= 0x23FF) || (cp >= 0x2B00 && cp <= 0x2BFF) || cp === 0x00A9 || cp === 0x00AE ||
    cp === 0x203C || cp === 0x2049 || cp === 0x2122 || cp === 0x2139 || (cp >= 0x2460 && cp <= 0x24FF) ||
    (cp >= 0x25A0 && cp <= 0x25FF) || (cp >= 0x2900 && cp <= 0x297F) || (cp >= 0x3030 && cp <= 0x303D) ||
    cp === 0x3297 || cp === 0x3299 || (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2A ||
    (cp >= 0x1F1E6 && cp <= 0x1F1FF) || cp === 0x20E3;
}

// Letters from scripts that have Latin look-alikes.
function scriptOf(cp) {
  if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) return 'Latin';
  if (cp >= 0x0400 && cp <= 0x04FF) return 'Cyrillic';
  if (cp >= 0x0370 && cp <= 0x03FF) return 'Greek';
  if (cp >= 0x0530 && cp <= 0x058F) return 'Armenian';
  if (cp >= 0xFF21 && cp <= 0xFF5A) return 'Fullwidth';
  return null;
}

export function mixedScriptWords(text) {
  const hits = [];
  const re = /[\p{L}\p{M}]{2,}/gu;
  for (const m of text.matchAll(re)) {
    const scripts = new Set();
    for (const ch of m[0]) { const s = scriptOf(ch.codePointAt(0)); if (s) scripts.add(s); }
    if (scripts.size > 1 && scripts.has('Latin')) hits.push({ index: m.index, word: m[0], scripts: [...scripts] });
  }
  return hits;
}

// Scans text; returns [{ line, col, cp, code, name, kind }].
export function scanUnicode(text) {
  const out = [];
  const cps = Array.from(text, c => c.codePointAt(0));
  let line = 1, col = 1;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const kind = classify(cp, i > 0 ? cps[i - 1] : null, i + 1 < cps.length ? cps[i + 1] : null, i);
    if (kind) out.push({ line, col, cp, code: hex(cp), name: cpName(cp), kind });
    if (cp === 0x0A) { line++; col = 1; } else col++;
  }
  return out;
}

export function lineColAt(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  return { line, col: index - before.lastIndexOf('\n') };
}

// Invisible-only text (e.g. a run of tag characters) decoded to show what it hides.
export function decodeTagRun(text) {
  let s = '';
  for (const ch of text) { const cp = ch.codePointAt(0); if (cp >= 0xE0020 && cp <= 0xE007E) s += String.fromCharCode(cp - 0xE0000); }
  return s;
}
