// A strict reader for the small YAML subset used in SKILL.md, command and agent front matter.
// It reports the traps that make Claude Code silently drop the whole front matter:
//   - a plain (unquoted) value that starts with [ { @ ` | > % * & ! (only | and > are allowed
//     as block markers when nothing follows them),
//   - a plain value containing ": " (YAML reads it as a nested mapping and fails),
//   - an unterminated quoted value.
// It also notes " #" in a plain value, which YAML treats as the start of a comment.

export function splitFrontmatter(text) {
  const t = text.replace(/^\uFEFF/, '');
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  const startLine = 2;
  return { raw: m[1], body: t.slice(m[0].length), startLine, bodyStartLine: m[1].split('\n').length + 3 };
}

function unquote(v, line, errors) {
  if (v.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"\s*(#.*)?$/.test(v)) { errors.push({ line, msg: 'unterminated or malformed double-quoted value' }); return v; }
    try { return JSON.parse(v.replace(/\s*#.*$/, '').trim()); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'\s*(#.*)?$/.test(v)) { errors.push({ line, msg: 'unterminated or malformed single-quoted value' }); return v; }
    return v.replace(/\s*#.*$/, '').trim().slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function checkPlain(key, v, line, errors, notes) {
  if (/^[\[{]/.test(v)) {
    // A flow list/map is valid YAML only if its first bracket closes at the very end of the value
    // (ignoring a trailing comment). "[days] [all]" closes early, so YAML rejects the line.
    const kind = v[0] === '[' ? 'list' : 'map';
    let depth = 0, end = -1, quote = null;
    for (let i = 0; i < v.length; i++) {
      const ch = v[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const rest = end < 0 ? null : v.slice(end + 1).replace(/\s+#.*$/, '').trim();
    if (end < 0 || rest) errors.push({ line, msg: `value of "${key}" starts with "${v[0]}" but isn't a single complete ${kind}; quote it` });
    return { flow: kind };
  }
  if (/^[@`%*&!]/.test(v)) errors.push({ line, msg: `value of "${key}" starts with "${v[0]}", which YAML reserves; quote the value` });
  if (/^[|>]/.test(v) && !/^[|>][-+0-9]*\s*$/.test(v)) errors.push({ line, msg: `value of "${key}" starts with "${v[0]}"; quote the value` });
  if (/:\s/.test(v) || /:$/.test(v)) errors.push({ line, msg: `value of "${key}" contains ": ", which YAML reads as a nested key; quote the value` });
  if (/\s#/.test(v)) notes.push({ line, msg: `value of "${key}" contains " #": YAML drops everything after it as a comment` });
  return {};
}

// Returns { data, errors, notes, keys, lines } where lines maps key -> line number in the file.
export function parseFrontmatter(text) {
  const fm = splitFrontmatter(text);
  if (!fm) return null;
  const data = {}, errors = [], notes = [], lines = {}, keys = [], flow = {};
  const rows = fm.raw.split(/\r?\n/);
  let i = 0;
  while (i < rows.length) {
    const lineNo = fm.startLine + i;
    const row = rows[i];
    if (/^\s*(#.*)?$/.test(row)) { i++; continue; }
    const m = row.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (!m) {
      if (/^\s/.test(row)) errors.push({ line: lineNo, msg: 'indented line that isn\'t part of a value' });
      else errors.push({ line: lineNo, msg: `not a "key: value" line: ${row.slice(0, 60)}` });
      i++; continue;
    }
    const key = m[1];
    let rest = m[2];
    if (rest && !/^\s/.test(rest)) { errors.push({ line: lineNo, msg: `missing space after "${key}:"` }); }
    rest = rest.trim();
    if (key in data) errors.push({ line: lineNo, msg: `duplicate key "${key}"` });
    keys.push(key); lines[key] = lineNo;
    i++;
    // Collect indented continuation lines.
    const cont = [];
    while (i < rows.length && (/^\s+\S/.test(rows[i]) || /^\s*$/.test(rows[i]))) { cont.push(rows[i]); i++; }
    while (cont.length && /^\s*$/.test(cont[cont.length - 1])) cont.pop();
    if (rest === '' && cont.length) {
      if (cont.every(c => /^\s*$/.test(c) || /^\s*-\s/.test(c) || /^\s*-$/.test(c))) {
        data[key] = cont.filter(c => /\S/.test(c)).map(c => c.replace(/^\s*-\s?/, '').trim());
      } else if (cont.every(c => /^\s*$/.test(c) || /^\s+[A-Za-z0-9_-]+\s*:/.test(c))) {
        const obj = {};
        for (const c of cont) { const mm = c.match(/^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/); if (mm) obj[mm[1]] = mm[2].trim(); }
        data[key] = obj;
      } else {
        errors.push({ line: lineNo, msg: `"${key}" has indented lines that are neither a list nor a map` });
        data[key] = cont.join('\n').trim();
      }
      continue;
    }
    if (/^[|>][-+0-9]*$/.test(rest)) { data[key] = cont.map(c => c.trim()).join(rest[0] === '|' ? '\n' : ' ').trim(); continue; }
    const q = unquote(rest, lineNo, errors);
    if (q !== null) {
      data[key] = q;
      if (cont.length) data[key] += ' ' + cont.map(c => c.trim()).join(' ');
      continue;
    }
    const r = checkPlain(key, rest, lineNo, errors, notes);
    if (r.flow) flow[key] = r.flow;
    let value = rest.replace(/\s+#.*$/, '');
    if (cont.length) value += ' ' + cont.map(c => c.trim()).join(' ');
    if (value === 'true') data[key] = true;
    else if (value === 'false') data[key] = false;
    else if (r.flow === 'list') data[key] = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    else data[key] = value;
  }
  return { data, errors, notes, keys, lines, flow, body: fm.body, bodyStartLine: fm.bodyStartLine };
}
