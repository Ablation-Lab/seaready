// The checks. Each adds findings: { sev: FAIL|WARN|INFO|PASS, id, title, detail, file, line, policy, portal, fix }.
//   FAIL = the portal blocks or stops validation, or a clear Directory Policy problem.
//   WARN = likely held for a reviewer, or worth fixing before you submit.
//   INFO = facts for the submission sheet, nothing to fix.
import * as R from './rules.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { scanUnicode, mixedScriptWords, lineColAt, decodeTagRun } from './unicode.mjs';
import { findClashes, findOverlaps } from './directory.mjs';

export function createFindings() {
  const list = [];
  const add = (sev, id, title, o = {}) => { list.push({ sev, id, title, ...o }); };
  return { list, add };
}

export const isText = buf => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return false; return true; };
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
export const maskEmail = e => { const [u, d] = e.split('@'); return `${u.slice(0, 2)}…@${d}`; };
const rel = (p, base) => base && p.startsWith(base + '/') ? p.slice(base.length + 1) : p;

// Strips fenced code blocks; returns text with code replaced by blank lines (keeps line numbers).
export function stripCode(md) {
  return md.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, m => m.replace(/[^\n]/g, ' '));
}

export function headings(md) {
  const out = [];
  const plain = stripCode(md);
  plain.split('\n').forEach((l, i) => { const m = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/); if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 }); });
  return out;
}

export function githubSlug(h) {
  return h.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
}

// Section text under the first heading that matches re (until the next heading of the same or higher level).
export function section(md, re) {
  const lines = md.split('\n');
  const hs = headings(md);
  const h = hs.find(x => re.test(x.text));
  if (!h) return null;
  const next = hs.find(x => x.line > h.line && x.level <= h.level);
  return { heading: h.text, line: h.line, text: lines.slice(h.line, next ? next.line - 1 : lines.length).join('\n') };
}

// Extracts example prompts from a README: lines in fenced blocks, bullets and quotes under a prompts heading.
export function examplePrompts(md) {
  const sec = section(md, /prompt|how to ask|try (it|these)|examples?\b|what to say|things to (ask|say)/i);
  const found = [];
  const scan = (text) => {
    let inCode = false;
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (/^(```|~~~)/.test(l)) { inCode = !inCode; continue; }
      if (inCode) { if (l && !/^[$>#]\s/.test(l) && !/^(node|npm|git|powershell|cd|claude)\b/.test(l)) found.push(l.replace(/^["“]|["”]$/g, '')); continue; }
      const b = l.match(/^(?:[-*+]|\d+\.)\s+(?:\*\*[^*]+\*\*:?\s*)?["“`>]?(.+?)["”`]?$/);
      if (b && /[a-z]/i.test(b[1]) && b[1].split(/\s+/).length >= 3) found.push(b[1]);
      else { const q = l.match(/^>\s*["“]?(.+?)["”]?$/); if (q && q[1].split(/\s+/).length >= 3) found.push(q[1]); }
    }
  };
  if (sec) scan(sec.text);
  return { heading: sec?.heading || null, line: sec?.line || null, prompts: [...new Set(found)].slice(0, 20) };
}

function words(md) {
  return stripCode(md).replace(/<!--[\s\S]*?-->/g, ' ').replace(/[#>*_`|[\]()!-]/g, ' ').split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), complete: buf.includes(Buffer.from('IEND')) };
}

function validImage(p, buf) {
  if (/\.png$/i.test(p)) return pngSize(buf)?.complete;
  if (/\.jpe?g$/i.test(p)) return buf[0] === 0xFF && buf[1] === 0xD8 && buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  if (/\.gif$/i.test(p)) return buf.slice(0, 3).toString() === 'GIF';
  if (/\.webp$/i.test(p)) return buf.slice(8, 12).toString() === 'WEBP';
  if (/\.svg$/i.test(p)) return isText(buf);
  return false;
}

// ---------------------------------------------------------------------------------------------
// Repository layout, sizes, file types
export function checkLayout(ctx, F) {
  const { files, tree, pluginDir, archiveBytes } = ctx;
  const inPlugin = p => !pluginDir || p === pluginDir || p.startsWith(pluginDir + '/');
  if (pluginDir && !/^[A-Za-z0-9._\/-]+$/.test(pluginDir))
    F.add('FAIL', 'LAYOUT-PATH', 'Plugin path has characters the portal rejects', { detail: `"${pluginDir}" must use letters, digits, dots, hyphens and underscores only.`, portal: 'Validation stops' });
  const lower = new Map();
  for (const e of tree) {
    const parts = e.path.split('/');
    for (const part of parts) {
      if (/[:<>"|?*\\]/.test(part) || /[. ]$/.test(part) || R.WIN_DEVICE.test(part) || /[\x00-\x1f]/.test(part)) {
        F.add('FAIL', 'LAYOUT-NAME', 'File name not valid on Windows or macOS', { file: e.path, detail: `"${part}" has a reserved character, a trailing dot or space, or is a Windows device name.`, portal: 'Validation stops', fix: 'Rename it.' });
        break;
      }
    }
    const k = e.path.toLowerCase();
    if (lower.has(k) && lower.get(k) !== e.path) F.add('FAIL', 'LAYOUT-CASE', 'Two paths differ only by capitalisation', { file: e.path, detail: `Also: ${lower.get(k)}`, portal: 'Validation stops' });
    lower.set(k, e.path);
    if (R.SYSTEM_FILES.test(e.path)) F.add(inPlugin(e.path) ? 'FAIL' : 'WARN', 'LAYOUT-SYSFILE', 'macOS or Windows system file committed', { file: e.path, portal: inPlugin(e.path) ? 'Blocks' : null, fix: 'git rm --cached it and add it to .gitignore.' });
    if (e.mode === '120000') F.add(inPlugin(e.path) ? 'FAIL' : 'WARN', 'LAYOUT-SYMLINK', 'Symbolic link', { file: e.path, portal: inPlugin(e.path) ? 'Blocks (where the plugin loads it)' : 'Warning', fix: 'Commit the real file instead.' });
    if (e.mode === '160000') F.add(inPlugin(e.path) ? 'FAIL' : 'WARN', 'LAYOUT-SUBMODULE', 'Git submodule', { file: e.path, portal: inPlugin(e.path) ? 'Blocks (where the plugin loads it)' : 'Warning', fix: 'Vendor the files the plugin needs.' });
  }
  const pluginFiles = [...files.keys()].filter(inPlugin);
  let unpacked = 0;
  for (const [p, f] of files) {
    unpacked += f.data.length;
    if (f.data.length < 300 && f.data.toString('utf8').startsWith('version https://git-lfs.github.com/spec'))
      F.add(inPlugin(p) ? 'FAIL' : 'WARN', 'LAYOUT-LFS', 'Git LFS pointer instead of the real file', { file: p, portal: inPlugin(p) ? 'Blocks' : 'Warning' });
  }
  if (archiveBytes > 50 * 1024 * 1024) F.add('FAIL', 'LAYOUT-SIZE', 'Repository archive over 50 MiB', { detail: `${(archiveBytes / 1048576).toFixed(1)} MiB`, portal: 'Validation stops' });
  if (unpacked > 256 * 1024 * 1024) F.add('FAIL', 'LAYOUT-SIZE', 'Repository over 256 MiB unpacked', { portal: 'Validation stops' });
  if (tree.length >= 10000) F.add('FAIL', 'LAYOUT-COUNT', 'Repository has 10,000 or more files', { portal: 'Validation stops' });
  if (pluginFiles.length > 512) F.add('WARN', 'LAYOUT-COUNT', 'Plugin folder has more than 512 files', { detail: `${pluginFiles.length} files`, portal: 'Held for a reviewer' });
  for (const p of pluginFiles) {
    const f = files.get(p);
    const size = f.data.length;
    const img = R.IMAGE_EXT.test(p), font = R.FONT_EXT.test(p);
    if (size > 5 * 1024 * 1024) F.add('FAIL', 'FILE-SIZE', 'File in the plugin folder over 5 MiB', { file: p, portal: 'Validation stops' });
    else if (!img && !font && size > 256 * 1024) F.add('WARN', 'FILE-SIZE', 'File over 256 KiB (not an image or font)', { file: p, detail: `${Math.round(size / 1024)} KiB`, portal: 'Held for a reviewer', fix: 'Split it, trim it, or move it outside the plugin folder.' });
    if (img && !validImage(p, f.data)) F.add('WARN', 'FILE-IMAGE', 'Image file is incomplete or not what its extension says', { file: p, portal: 'Held for a reviewer' });
    if (!img && !font && (R.BINARY_EXT.test(p) || !isText(f.data)))
      F.add('WARN', 'FILE-BINARY', 'Binary file that is not an image or font', { file: p, portal: 'Held for a reviewer', detail: 'The validator only inspects text, complete PNG/JPEG/GIF/WebP images and fonts.', fix: 'Remove it from the plugin folder, or have a script generate it (as Cutproof does for its sample video).' });
  }
  return pluginFiles;
}

// ---------------------------------------------------------------------------------------------
// .gitattributes and line endings, compared on a real git archive
export function checkLineEndings(ctx, F) {
  const { files, blobsByPath, pluginDir, localConfig, localArchiveDiff, worktreeDiff } = ctx;
  const attrFiles = [...ctx.attributeTexts.keys()];
  const textAttrs = [];
  for (const p of attrFiles) {
    const text = ctx.attributeTexts.get(p);
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    const relevant = !pluginDir || dir === '' || pluginDir === dir || pluginDir.startsWith(dir + '/') || dir.startsWith(pluginDir + '/');
    text.split(/\r?\n/).forEach((line, i) => {
      const l = line.replace(/#.*/, '').trim();
      if (!l) return;
      if (/(^|\s)(export-ignore|export-subst)\b/.test(l))
        F.add('FAIL', 'GITATTR-EXPORT', 'export-ignore or export-subst in .gitattributes', { file: p, line: i + 1, detail: l, portal: 'Validation stops ("Couldn\'t validate that repository")', fix: 'Remove the attribute.' });
      if (/(^|\s)filter=/.test(l) && relevant)
        F.add('FAIL', 'GITATTR-FILTER', 'filter attribute (Git LFS included) rewrites file contents', { file: p, line: i + 1, detail: l, portal: 'Validation stops', fix: 'Remove it; commit real files.' });
      const attrs = l.split(/\s+/).slice(1);
      // "-text", "binary" and "-crlf" turn conversion off; these turn it on or rewrite content.
      const rewriting = attrs.filter(a => /^(text(=.*)?|eol=.*|crlf|working-tree-encoding=.*|ident)$/.test(a));
      if (rewriting.length && relevant) textAttrs.push({ file: p, line: i + 1, text: l });
    });
  }
  // GitHub-like archive vs stored blobs.
  const changed = [], missing = [];
  for (const [p, sha] of blobsByPath) {
    const f = files.get(p);
    if (!f) { missing.push(p); continue; }
    const blob = ctx.blobs.get(sha);
    if (blob && !blob.equals(f.data)) changed.push(p);
  }
  if (changed.length) F.add('FAIL', 'EOL-ARCHIVE', 'git archive rewrites files, so GitHub\'s archive differs from the repo', {
    detail: `With GitHub's settings (core.autocrlf=false, core.eol=lf) the archive changes ${changed.length} file(s): ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ' …' : ''}. SessionKeeper hit this with "*.cmd text eol=crlf".`,
    portal: 'Validation stops', fix: 'Store the file the way you want it shipped (e.g. CRLF) and mark it "-text" in .gitattributes, or drop the eol rule.' });
  else F.add('PASS', 'EOL-ARCHIVE', 'git archive matches the stored files byte for byte', { detail: `${blobsByPath.size} files compared using GitHub's settings.` });
  if (textAttrs.length) F.add(changed.length ? 'WARN' : 'INFO', 'GITATTR-TEXT', `Line-ending or encoding attributes in .gitattributes (${textAttrs.length})`, { file: textAttrs[0].file, line: textAttrs[0].line,
    detail: textAttrs.map(a => `${a.file}:${a.line}  ${a.text}`).join('\n') + (changed.length ? '\nThese rewrite files in the archive (see EOL-ARCHIVE).' : '\nThey change nothing in a GitHub-like archive today, so they pass (Lore Lookup validated with "* text=auto eol=lf"). A file added later with other line endings would be rewritten; this check re-tests that on every run.'),
    portal: changed.length ? 'Validation stops' : null, fix: changed.length ? 'Remove the rule, or store the files as the rule writes them and mark them -text.' : undefined });
  if (missing.length) F.add('FAIL', 'EOL-MISSING', 'Files missing from git archive (export-ignore?)', { detail: missing.slice(0, 8).join(', '), portal: 'Validation stops' });
  // Local skew.
  const ac = localConfig.autocrlf, eol = localConfig.eol;
  if ((ac && ac !== 'false') || eol === 'crlf') {
    F.add('WARN', 'EOL-LOCAL', `This machine's git config (core.autocrlf=${ac ?? 'unset'}${eol ? `, core.eol=${eol}` : ''}) skews local results`, {
      detail: `Your working tree and local zips/archives can have CRLF line endings that GitHub's copy doesn't${localArchiveDiff ? ` (a local git archive differs in ${localArchiveDiff} file(s))` : ''}${worktreeDiff ? `; ${worktreeDiff} working-tree file(s) differ from what's committed only by line endings` : ''}. Greps, hashes and byte counts done on the working tree won't match what the portal sees. This report reads the committed blobs and a GitHub-like archive instead.`,
      fix: 'For this repo: git config core.autocrlf false, then re-checkout (git rm --cached -r . && git reset --hard) when the tree is clean.' });
  }
  // Script line endings that break their interpreter.
  for (const [p, f] of files) {
    if (!isText(f.data)) continue;
    const crlf = f.data.includes(Buffer.from('\r\n'));
    const lfOnly = !crlf && f.data.includes(10);
    if (R.SHELL_EXT.test(p) && crlf) F.add('WARN', 'EOL-SH', 'Shell script stored with CRLF line endings', { file: p, detail: 'bash fails on the \\r ("$\'\\r\': command not found").', fix: 'Store it with LF.' });
    if (R.BATCH_EXT.test(p) && lfOnly) F.add('WARN', 'EOL-CMD', 'Batch file stored with LF line endings', { file: p, detail: 'cmd.exe can misread labels and GOTO/CALL in LF-only batch files.', fix: 'Store it with CRLF and mark it "-text" in .gitattributes (as SessionKeeper\'s install.cmd is).' });
  }
}

// ---------------------------------------------------------------------------------------------
// plugin.json and marketplace.json
export function checkManifest(ctx, F) {
  const { files, pluginDir, listings, ownRepoKey, remote } = ctx;
  const pj = (pluginDir ? pluginDir + '/' : '') + '.claude-plugin/plugin.json';
  const facts = { manifestPath: pj };
  const f = files.get(pj);
  if (!f) {
    const hasSkills = [...files.keys()].some(p => p.startsWith((pluginDir ? pluginDir + '/' : '') + 'skills/') && p.endsWith('/SKILL.md'));
    F.add(hasSkills ? 'INFO' : 'FAIL', 'MANIFEST-MISSING', 'No .claude-plugin/plugin.json in the plugin folder', { detail: hasSkills ? 'A folder with skills/<name>/SKILL.md and no plugin.json passes with a note and is listed for Claude Code only.' : 'Submit the folder that contains .claude-plugin/plugin.json.', portal: hasSkills ? 'Note' : 'Blocks' });
    return facts;
  }
  let m;
  const raw = f.data.toString('utf8');
  if (raw.charCodeAt(0) === 0xFEFF) F.add('WARN', 'MANIFEST-BOM', 'plugin.json starts with a byte order mark', { file: pj });
  try { m = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (e) { F.add('FAIL', 'MANIFEST-JSON', 'plugin.json is not valid JSON', { file: pj, detail: e.message, portal: 'Blocks' }); return facts; }
  facts.manifest = m;
  const name = m.name;
  // Name rules.
  if (!name) F.add('FAIL', 'MANIFEST-NAME', 'plugin.json has no name', { file: pj, portal: 'Blocks' });
  else {
    if (/[^\x00-\x7f]/.test(name)) F.add('FAIL', 'MANIFEST-NAME', 'Plugin name has non-ASCII characters', { file: pj, portal: 'Blocks ("Non-ASCII identifier")' });
    else if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) F.add('WARN', 'MANIFEST-NAME', 'Plugin name breaks the pattern (lowercase letters, digits, hyphens; up to 64; starts and ends with a letter or digit)', { file: pj, detail: name, portal: 'Warning' });
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const parts = n.split('-').filter(Boolean);
    if (/^(claude|anthropic|anthropics|cc-plugin)-/.test(n) || R.RESERVED_WHOLE.has(n) || (parts.includes('official') && (parts.includes('claude') || parts.includes('anthropic'))))
      F.add('FAIL', 'MANIFEST-RESERVED', 'Plugin name is reserved or passes as Anthropic\'s own', { file: pj, detail: name, portal: 'Blocks ("Name is taken")', fix: 'Build the name around your own product name.' });
    else if (parts.some(p => p === 'claude' || p === 'anthropic' || p === 'anthropics'))
      F.add('WARN', 'MANIFEST-RESERVED', 'Plugin name has "claude" or "anthropic" as a word', { file: pj, detail: `${name}: claude plugin validate warns that it "reads as one of Anthropic's own".`, portal: 'Warning / possible hold' });
    if (parts.length && parts.every(p => R.GENERIC_WORDS.has(p)))
      F.add('WARN', 'MANIFEST-GENERIC', 'Plugin name is made only of generic words', { file: pj, detail: name, portal: 'Held for a reviewer ("Name may be confused with an existing listing")' });
    // Clashes with existing listings.
    if (!listings.items.length) F.add('WARN', 'NAME-CLASH', 'Couldn\'t check name clashes: no local copy of the directory', { detail: 'Open /plugin in Claude Code (Discover / directory) once to refresh ~/.claude/plugins/plugin-directory-cache-v2.json, then run again.' });
    else {
      const { exact, similar } = findClashes(listings, { name, displayName: m.displayName }, ownRepoKey);
      const src = listings.sources.find(s => s.fetchedAt);
      const asOf = src ? ` (directory copy from ${src.fetchedAt.slice(0, 10)}, ${src.count} listings)` : '';
      if (exact.length) F.add('FAIL', 'NAME-CLASH', 'Name is already used by another listing', { file: pj, detail: exact.slice(0, 5).map(x => `${x.name || x.displayName} (${x.displayName}) from ${x.repo || x.origin}`).join('; ') + asOf, portal: 'Blocks ("Name is taken")', fix: 'Pick a different name before the first submission; names are permanent.' });
      const others = similar.filter(s => !s.own);
      if (others.length) F.add('WARN', 'NAME-SIMILAR', 'Name looks like existing listings', { file: pj, detail: others.slice(0, 6).map(x => `${x.name || x.displayName} [${x.how}]`).join('; ') + asOf, portal: 'Held for a reviewer if look-alike ("Name may be confused with an existing listing")' });
      if (!exact.length && !others.length) F.add('PASS', 'NAME-CLASH', 'No other listing uses this name or a look-alike', { detail: `Checked against ${listings.items.length} listings${asOf}.` });
      if (similar.some(s => s.own)) F.add('INFO', 'NAME-OWN', 'This repository already has a listing in the directory', { detail: similar.filter(s => s.own).map(s => s.name || s.displayName).join(', ') });
      const overlaps = findOverlaps(listings, `${m.displayName || ''} ${m.description || ''}`).filter(o => !(ownRepoKey && o.repo?.toLowerCase().includes(ownRepoKey)));
      if (overlaps.length) F.add('INFO', 'OVERLAP', 'Listings with similar descriptions (policy 2C: descriptions must not create confusion with other listings)', { detail: overlaps.map(o => `${o.displayName || o.name} — ${o.summary.slice(0, 110)}`).join('\n'), policy: '2C', fix: 'Say in the README how yours differs ("How it compares").' });
      facts.overlaps = overlaps;
    }
  }
  for (const k of ['displayName']) if (m[k] != null) checkDisplayText(m[k], k, pj, F);
  if (m.author?.name) checkDisplayText(m.author.name, 'author.name', pj, F);
  if (!m.description) F.add('WARN', 'MANIFEST-FIELDS', 'plugin.json has no description', { file: pj, portal: 'Warning' });
  if (!m.author) F.add('WARN', 'MANIFEST-FIELDS', 'plugin.json has no author', { file: pj, portal: 'Warning' });
  else if (typeof m.author !== 'object' || !m.author.name) F.add('WARN', 'MANIFEST-FIELDS', 'author must be an object with a name', { file: pj });
  if (!m.version) F.add('WARN', 'MANIFEST-FIELDS', 'plugin.json has no version', { file: pj, portal: 'Warning', fix: 'Set version and raise it with every release.' });
  for (const k of Object.keys(m)) if (!R.KNOWN_MANIFEST_KEYS.has(k)) F.add('WARN', 'MANIFEST-KEY', `Unknown key "${k}" in plugin.json`, { file: pj, detail: 'A misspelled component key (e.g. hooks, mcpServers) blocks.', portal: 'Blocks if it is a misspelled component key' });
  if (m.experimental && typeof m.experimental === 'object') for (const k of ['hooks', 'mcpServers', 'skills', 'commands', 'agents'])
    if (k in m.experimental) F.add('FAIL', 'MANIFEST-KEY', `"${k}" inside "experimental"`, { file: pj, portal: 'Blocks' });
  // Component paths stay inside the plugin.
  for (const k of R.COMPONENT_KEYS) {
    const v = m[k];
    const paths = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    for (const p of paths) if (/^(\.\.[\\/]|\/|[A-Za-z]:)/.test(p) || /[\\/]\.\.[\\/]/.test(p)) F.add('FAIL', 'MANIFEST-PATH', `${k} path points outside the plugin folder`, { file: pj, detail: p, portal: 'Blocks' });
  }
  if (m.hooks === './hooks/hooks.json' || (Array.isArray(m.hooks) && m.hooks.includes('./hooks/hooks.json')))
    F.add('WARN', 'MANIFEST-HOOKS', 'hooks/hooks.json is listed in plugin.json', { file: pj, detail: 'Claude Code loads it automatically; listing it again is a warning.', portal: 'Warning' });
  // Licence.
  const licFile = [...files.keys()].some(p => new RegExp(`^${pluginDir ? escapeRe(pluginDir) + '/' : ''}(LICEN[SC]E|COPYING)(\\.[a-z]+)?$`, 'i').test(p));
  if (!m.license && !licFile) F.add('FAIL', 'LICENSE', 'No licence: no LICENSE file in the plugin folder and no "license" in plugin.json', { file: pj, portal: 'Blocks ("License missing")', fix: 'Add "license": "MIT" (or your SPDX id) and a LICENSE file.' });
  else F.add('PASS', 'LICENSE', 'Licence found', { detail: m.license ? `license: ${m.license}` : 'LICENSE file' });
  // Directory listing fields.
  const urlFields = [['documentationUrl', 'WARN', 'Documentation link'], ['supportUrl', 'WARN', 'Support link (policy 3B)'], ['privacyPolicyUrl', 'WARN', 'Privacy policy link (policy 3A)'], ['termsOfServiceUrl', 'INFO', 'Terms of service link (optional)']];
  for (const [k, sev, label] of urlFields) {
    const v = m[k];
    if (!v) { F.add(sev, 'MANIFEST-URLS', `${label}: ${k} not set`, { file: pj, detail: k === 'termsOfServiceUrl' ? 'Optional. The directory shows it if set; most small plugins leave it out.' : 'The directory reads it from plugin.json; the portal warns when it\'s missing.', portal: sev === 'INFO' ? 'Optional' : 'Warning', policy: k === 'supportUrl' ? '3B' : k === 'privacyPolicyUrl' ? '3A' : undefined }); continue; }
    if (!/^https:\/\/[^\s`'"<>]+$/.test(v)) F.add('FAIL', 'MANIFEST-URLS', `${k} is not a clean https:// URL`, { file: pj, detail: JSON.stringify(v), fix: 'Use a plain https:// URL with no stray characters (Lore Lookup once picked up a backtick).' });
    else F.add('PASS', 'MANIFEST-URLS', `${k} set`, { detail: v });
    checkOwnUrl(v, k, remote, pj, F, ctx);
  }
  if (m.homepage) { try { new URL(m.homepage); } catch { F.add('FAIL', 'MANIFEST-URLS', 'homepage is not a valid URL', { file: pj, detail: 'Claude Code refuses to load the plugin.' }); } }
  // Icon.
  if (!m.icon) F.add('WARN', 'ICON', 'No icon in plugin.json', { file: pj, fix: 'Add a square PNG (512×512 works) inside the plugin and set "icon": "./.claude-plugin/icon.png".' });
  else {
    const ip = joinPath(pluginDir, m.icon);
    const icon = files.get(ip);
    if (!icon) F.add('FAIL', 'ICON', 'Icon file not found inside the plugin folder', { file: pj, detail: m.icon });
    else {
      const s = pngSize(icon.data);
      if (/\.png$/i.test(ip) && s) {
        if (s.w !== s.h) F.add('WARN', 'ICON', 'Icon is not square', { file: ip, detail: `${s.w}×${s.h}` });
        else if (s.w < 256) F.add('WARN', 'ICON', 'Icon is small', { file: ip, detail: `${s.w}×${s.h}; 512×512 is what our listings use.` });
        else F.add('PASS', 'ICON', 'Icon found', { detail: `${ip}, ${s.w}×${s.h}` });
      } else F.add('PASS', 'ICON', 'Icon found', { detail: ip });
      facts.icon = ip;
    }
  }
  // Classification: keywords, marketplace category and tags.
  F.add('INFO', 'CLASSIFY', 'Classification fields (optional)', { detail: `keywords: ${Array.isArray(m.keywords) ? m.keywords.join(', ') : 'not set'}; marketplace category/tags: see below. None of these is required by the portal.` });
  // Marketplace.
  const mpPath = '.claude-plugin/marketplace.json';
  const mpf = files.get(mpPath) || (pluginDir ? files.get(joinPath(pluginDir, mpPath)) : null);
  if (mpf) {
    try {
      const mp = JSON.parse(mpf.data.toString('utf8').replace(/^\uFEFF/, ''));
      facts.marketplace = mp;
      const entry = (mp.plugins || []).find(p => p.name === name);
      if ((mp.plugins || []).length > 1) F.add('INFO', 'MARKETPLACE', 'The marketplace lists several plugins: submit each plugin folder on its own', { file: mpPath });
      if (!entry) F.add('WARN', 'MARKETPLACE', `marketplace.json has no entry named "${name}"`, { file: mpPath });
      else {
        facts.mpEntry = entry;
        if (entry.version && m.version && entry.version !== m.version) F.add('FAIL', 'VERSION-MATCH', 'Versions differ between plugin.json and marketplace.json', { file: mpPath, detail: `plugin.json ${m.version}, marketplace.json ${entry.version}`, fix: 'Keep them equal (Cutproof\'s standing rule).' });
        else if (entry.version && m.version) F.add('PASS', 'VERSION-MATCH', 'plugin.json and marketplace.json versions match', { detail: m.version });
        const src = typeof entry.source === 'string' ? entry.source.replace(/^\.\/?/, '').replace(/\/$/, '') : null;
        if (src != null && src !== (pluginDir || '')) F.add('WARN', 'MARKETPLACE', 'marketplace source doesn\'t point at the plugin folder being checked', { file: mpPath, detail: `source "${entry.source}", plugin folder "${pluginDir || '.'}"` });
        for (const k of ['icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl'])
          if (k in entry) F.add('WARN', 'MARKETPLACE', `"${k}" in the marketplace entry`, { file: mpPath, detail: 'Directory listing fields belong only in plugin.json; claude plugin validate reports them as unknown here.' });
        facts.category = entry.category; facts.tags = entry.tags;
      }
    } catch (e) { F.add('FAIL', 'MARKETPLACE', 'marketplace.json is not valid JSON', { file: mpPath, detail: e.message }); }
  }
  return facts;
}

function checkDisplayText(v, k, file, F) {
  const issues = scanUnicode(String(v)).filter(x => x.kind === 'hidden');
  if (issues.length) F.add('FAIL', 'MANIFEST-TEXT', `${k} has invisible characters`, { file, detail: issues.map(i => i.code).join(', '), portal: 'Blocks' });
  if (mixedScriptWords(String(v)).length) F.add('FAIL', 'MANIFEST-TEXT', `${k} mixes writing systems (look-alike letters)`, { file, detail: String(v), portal: 'Blocks' });
}

function checkOwnUrl(url, k, remote, file, F, ctx) {
  if (!remote?.ownerRepo) return;
  const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)/i);
  if (m && m[1].toLowerCase().replace(/\.git$/, '') !== remote.ownerRepo.toLowerCase())
    F.add('WARN', 'MANIFEST-URLS', `${k} points at a different GitHub repo than origin`, { file, detail: `${url} vs origin ${remote.ownerRepo}` });
  const anchor = url.split('#')[1];
  if (anchor && ctx.readme) {
    const slugs = headings(ctx.readme.text).map(h => githubSlug(h.text));
    if (!slugs.includes(anchor.toLowerCase())) F.add('WARN', 'MANIFEST-URLS', `${k} anchor #${anchor} doesn't match a README heading`, { file, detail: `Headings: ${slugs.slice(0, 12).join(', ')}` });
  }
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function joinPath(dir, p) {
  const parts = (dir ? dir.split('/') : []);
  for (const seg of p.replace(/\\/g, '/').split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}

// ---------------------------------------------------------------------------------------------
// Skills, commands, agents
export function checkComponents(ctx, F) {
  const { files, pluginDir } = ctx;
  const base = pluginDir ? pluginDir + '/' : '';
  const skills = [], commands = [], agents = [];
  for (const p of files.keys()) {
    if (!p.startsWith(base)) continue;
    const r = p.slice(base.length);
    if (/^skills\/[^/]+\/SKILL\.md$/.test(r)) skills.push(p);
    else if (/^skills\/[^/]+\/skill\.md$/i.test(r)) F.add('FAIL', 'SKILL-CASE', 'Skill file must be named SKILL.md exactly', { file: p, portal: 'Blocks' });
    else if (/^commands\/.+\.md$/i.test(r)) commands.push(p);
    else if (/^agents\/.+\.md$/i.test(r)) agents.push(p);
    else if (/(^|\/)SKILL\.md$/.test(r) && !R.TEST_PATH.test(r)) {
      // A skill outside skills/<name>/: Claude Code won't load it from the plugin, but it's still
      // what people upload to claude.ai, so its name and description are checked too.
      F.add('WARN', 'SKILL-LOCATION', 'SKILL.md outside skills/<name>/', { file: p, detail: 'Plugins load skills from skills/<name>/SKILL.md (or paths listed under "skills" in plugin.json).' });
      skills.push(p);
    }
  }
  if (!skills.length && !commands.length && !agents.length && !files.has(base + 'hooks/hooks.json') && !files.has(base + '.mcp.json'))
    F.add('WARN', 'COMPONENTS', 'The plugin folder has no skills, commands, agents, hooks or MCP servers', { detail: 'Check the plugin path.' });
  const out = { skills: [], commands: [], agents: [] };
  for (const p of skills) out.skills.push(checkSkill(p, files.get(p).data.toString('utf8'), F));
  for (const p of commands) out.commands.push(checkCommandOrAgent(p, files.get(p).data.toString('utf8'), F, 'command'));
  for (const p of agents) out.agents.push(checkCommandOrAgent(p, files.get(p).data.toString('utf8'), F, 'agent'));
  // Hooks and MCP.
  const hooksPath = base + 'hooks/hooks.json';
  if (files.has(hooksPath)) out.hooks = checkHooks(hooksPath, files.get(hooksPath).data.toString('utf8'), F, !!pluginDir);
  const mcpPath = base + '.mcp.json';
  if (files.has(mcpPath)) out.mcp = checkMcp(mcpPath, files.get(mcpPath).data.toString('utf8'), F, ctx);
  if ([...files.keys()].some(p => p.startsWith(base + 'bin/'))) { out.bin = true; F.add('INFO', 'BIN', 'Top-level bin/ folder: chat and Cowork refuse to install the plugin; Claude Code only', { portal: 'Listed for Claude Code only' }); }
  return out;
}

function frontmatterFindings(p, text, F, kind) {
  const fm = parseFrontmatter(text);
  if (!fm) { F.add('WARN', 'FRONTMATTER', `${kind} file has no front matter`, { file: p, portal: 'Warning' }); return null; }
  for (const e of fm.errors) F.add('FAIL', 'FRONTMATTER', `Front matter won't parse: ${e.msg}`, { file: p, line: e.line, portal: 'Blocks', detail: 'When front matter fails to parse, Claude Code silently drops all of it (SessionKeeper hit this with an unquoted value starting with "[").', fix: 'Quote the value with double quotes.' });
  for (const n of fm.notes) F.add('WARN', 'FRONTMATTER', n.msg, { file: p, line: n.line, fix: 'Quote the value.' });
  if (fm.data.description == null || fm.data.description === '') F.add(kind === 'skill' ? 'WARN' : 'WARN', 'FRONTMATTER', `${kind} has no description`, { file: p, portal: 'Warning' });
  else if (typeof fm.data.description !== 'string') F.add('FAIL', 'FRONTMATTER', 'description must be a single text value, not a list or map', { file: p, line: fm.lines.description, portal: 'Blocks' });
  return fm;
}

function checkTriggerText(p, text, line, F, label) {
  for (const [re, why] of R.TRIGGER_PHRASES) {
    const m = text.match(re);
    if (m) F.add('WARN', 'TRIGGER', `Over-broad trigger wording in the ${label}: "${m[0]}"`, { file: p, line, policy: '2A, 2C, 2D', detail: why, fix: 'Say when to use it narrowly ("Use when the user asks to …"), naming the specific requests. Lore Lookup changed "Use whenever" to "Use when" for this.' });
  }
}

export function checkSkill(p, text, F) {
  const folder = p.split('/').slice(-2, -1)[0];
  const info = { path: p, folder, name: null, description: null };
  const fm = frontmatterFindings(p, text, F, 'skill');
  if (!fm) return info;
  const d = fm.data;
  info.name = d.name || folder; info.description = typeof d.description === 'string' ? d.description : null; info.fm = fm;
  const name = d.name || folder;
  if (d.name && d.name !== folder) F.add('WARN', 'SKILL-NAME', 'Skill name doesn\'t match its folder', { file: p, line: fm.lines.name, detail: `name "${d.name}", folder "${folder}". The Agent Skills spec requires them to match (Cutproof renamed its folder for this).` });
  if (/claude|anthropic/i.test(name)) F.add('FAIL', 'SKILL-NAME', 'Skill name contains "claude" or "anthropic"', { file: p, line: fm.lines.name, detail: `${name}: claude.ai and the API refuse uploads whose skill name contains these words (Lore Lookup was renamed from claude-lore).`, fix: 'Rename the skill and its folder.' });
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) F.add('WARN', 'SKILL-NAME', 'Skill name should be lowercase letters, digits and single hyphens, up to 64 characters', { file: p, detail: name });
  if (info.description) {
    const desc = info.description;
    const combined = desc + (typeof d.when_to_use === 'string' ? ' ' + d.when_to_use : '');
    if (desc.length > 1024) F.add('WARN', 'SKILL-DESC', 'Description is over 1024 characters (Agent Skills limit for claude.ai uploads)', { file: p, line: fm.lines.description, detail: `${desc.length} characters` });
    if (combined.length > 1536) F.add('WARN', 'SKILL-DESC', 'description + when_to_use is over 1,536 characters; Claude Code truncates the listing', { file: p, detail: `${combined.length} characters` });
    if (/[<>]/.test(desc)) F.add('INFO', 'SKILL-DESC', 'Angle brackets in the description show as &lt; and &gt;', { file: p });
    if (!/\b(use (it |this )?when(ever)?|use for|when(ever)? the user|when someone|when you)\b/i.test(combined)) F.add('WARN', 'SKILL-DESC', 'Description doesn\'t say when to use the skill', { file: p, line: fm.lines.description, policy: '2A', detail: 'Policy 2A asks for narrow language that says what it does and when it should be invoked.' });
    checkTriggerText(p, combined, fm.lines.description, F, 'skill description');
    if (/\bofficial (plugin|skill|tool|integration|extension|anthropic|claude)\b|\b(made|built|published) by anthropic\b|\banthropic['’]s own (plugin|skill|tool)\b|\bendorsed by\b/i.test(desc)) F.add('WARN', 'SKILL-DESC', 'Description presents the skill as official', { file: p, detail: 'Names and descriptions must not present the plugin as official.' });
  }
  const nonPortable = fm.keys.filter(k => !R.PORTABLE_SKILL_FIELDS.has(k));
  if (nonPortable.length) F.add('WARN', 'SKILL-FIELDS', `Front matter fields claude.ai skill uploads reject: ${nonPortable.join(', ')}`, { file: p, detail: 'Plugins accept Claude Code\'s extra fields, but uploads to claude.ai and the Skills API accept only name, description, license, compatibility, metadata, allowed-tools (Lore Lookup folded when_to_use into its description for this).' });
  if (typeof d.compatibility === 'string' && d.compatibility.length > 500) F.add('WARN', 'SKILL-FIELDS', 'compatibility is over 500 characters', { file: p });
  if (d['allowed-tools'] != null) {
    const at = Array.isArray(d['allowed-tools']) ? d['allowed-tools'].join(' ') : String(d['allowed-tools']);
    const broad = /\b(Bash|PowerShell)\s*(\(\s*\*?\s*\))?(\s|,|$)|\bBash\(\s*\*|\bBash\([^)]*:\*\)|\bWrite\b|\bEdit\b/.test(at);
    F.add('WARN', 'SKILL-PREAPPROVE', broad ? 'allowed-tools pre-approves broad or write access' : 'allowed-tools pre-approves tools', { file: p, line: fm.lines['allowed-tools'], detail: `${at.slice(0, 200)}. Pre-approvals are read closely by the security scan; Cutproof and SessionKeeper removed theirs to clear their holds. With none, Claude Code asks before each command, and the README should say so.`, fix: 'Remove allowed-tools, or keep it to exact read-only commands and explain each in the README.' });
  }
  if (d['disable-model-invocation'] === true) F.add('INFO', 'SKILL-INVOCATION', 'disable-model-invocation hides this skill from Claude', { file: p, detail: 'Claude can\'t see it exists, so it may tell users it doesn\'t (SessionKeeper). Mention it in the other skills or commands.' });
  checkInstructionBody(p, fm.body, fm.bodyStartLine, F);
  const lines = fm.body.split('\n').length;
  if (lines > 500) F.add('INFO', 'SKILL-LENGTH', 'SKILL.md body is over 500 lines', { file: p, detail: 'Move detail into reference files that the skill loads when needed.' });
  return info;
}

function checkCommandOrAgent(p, text, F, kind) {
  const fm = frontmatterFindings(p, text, F, kind);
  const info = { path: p, name: p.split('/').pop().replace(/\.md$/i, ''), description: fm?.data?.description ?? null };
  if (!fm) { checkInstructionBody(p, text, 1, F); return info; }
  if (typeof info.description === 'string') checkTriggerText(p, info.description, fm.lines.description, F, `${kind} description`);
  if (fm.data['allowed-tools'] != null) F.add('WARN', 'SKILL-PREAPPROVE', `${kind} pre-approves tools with allowed-tools`, { file: p, detail: String(fm.data['allowed-tools']).slice(0, 200) });
  if (fm.data['disable-model-invocation'] === true) F.add('INFO', 'SKILL-INVOCATION', `${kind} is hidden from Claude (disable-model-invocation)`, { file: p });
  checkInstructionBody(p, fm.body, fm.bodyStartLine, F);
  return info;
}

// Instruction text: remote instructions (2F), hidden instructions (2G), chat history (1G), other tools (2E).
function checkInstructionBody(p, body, startLine, F) {
  for (const re of R.REMOTE_INSTRUCTIONS) {
    const m = body.match(re);
    if (m) F.add('FAIL', 'REMOTE-INSTRUCTIONS', 'Instructions pull behaviour from an external source', { file: p, line: startLine + lineOf(body, m.index) - 1, policy: '2F', detail: m[0].slice(0, 160), fix: 'Ship the instructions in the plugin; treat fetched content as data, never instructions.' });
  }
  const b64 = body.match(/[A-Za-z0-9+/]{120,}={0,2}/);
  if (b64) F.add('WARN', 'ENCODED', 'Long encoded-looking string in instructions', { file: p, line: startLine + lineOf(body, b64.index) - 1, policy: '2G', detail: 'Instructions must be human-readable; encoded blobs look like hidden instructions.' });
  for (const m of body.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (/\b(you must|ignore|always|never|do not tell|secretly|without telling)\b/i.test(m[1])) F.add('WARN', 'HIDDEN-COMMENT', 'HTML comment with instructions in it', { file: p, line: startLine + lineOf(body, m.index) - 1, policy: '2G', detail: m[1].trim().slice(0, 160), fix: 'HTML comments don\'t show in rendered Markdown; keep behaviour in visible text.' });
  }
  const m2 = body.match(/\b(do not|don't|never) (use|call|invoke) (any )?(other|another) (skills?|tools?|plugins?|mcp)/i);
  if (m2) F.add('WARN', 'OTHER-TOOLS', 'Instructions tell Claude not to use other tools', { file: p, line: startLine + lineOf(body, m2.index) - 1, policy: '2E', detail: m2[0] });
}

function checkHooks(p, text, F, subfolder) {
  let h;
  try { h = JSON.parse(text); } catch (e) { F.add('FAIL', 'HOOKS', 'hooks.json is invalid', { file: p, detail: e.message, portal: 'Blocks' }); return null; }
  if (!h.hooks && !h.modules) F.add('FAIL', 'HOOKS', 'hooks.json needs a top-level "hooks" object (or "modules" for a mod)', { file: p, portal: 'Blocks' });
  const cmds = [];
  for (const [ev, groups] of Object.entries(h.hooks || {})) {
    if (!R.HOOK_EVENTS.has(ev)) F.add('WARN', 'HOOKS', `Unknown hook event "${ev}"`, { file: p, detail: 'Check the spelling against the hooks reference; unknown events block.', portal: 'Blocks if not a real event' });
    for (const g of Array.isArray(groups) ? groups : []) for (const hk of g.hooks || []) {
      if (hk.type === 'http' && !/^https:\/\//.test(hk.url || '')) F.add('FAIL', 'HOOKS', 'HTTP hook URL must be https://', { file: p, portal: 'Blocks' });
      if (hk.type === 'command' || hk.command) {
        const c = [hk.command, ...(hk.args || [])].join(' ');
        cmds.push({ event: ev, command: c });
        if (subfolder && (/\$\{?(?!CLAUDE_PLUGIN_ROOT\b)[A-Za-z_]/.test(c) || /\$\(|`|\*|\s-c\s/.test(c)))
          F.add('FAIL', 'HOOKS', 'Hook command uses a variable other than ${CLAUDE_PLUGIN_ROOT}, a substitution, wildcard or inline program', { file: p, detail: c, portal: 'Blocks when the plugin is in a subfolder' });
        if (R.DOWNLOAD_RUN.some(([re]) => re.test(c)) || /\b(npx|uvx|bunx|pnpm dlx|yarn dlx|pipx run|uv run|npm (i|install)|pip install)\b/.test(c))
          F.add('WARN', 'HOOKS', 'Hook runs a package launcher or install', { file: p, detail: c, portal: 'Held for a reviewer' });
      }
    }
  }
  F.add('INFO', 'HOOKS', `Hooks: ${cmds.length} command hook(s)`, { file: p, detail: cmds.map(c => `${c.event}: ${c.command}`).join('\n') || 'none' });
  return { events: Object.keys(h.hooks || {}), commands: cmds };
}

function checkMcp(p, text, F, ctx) {
  let m;
  try { m = JSON.parse(text); } catch (e) { F.add('FAIL', 'MCP', '.mcp.json can\'t be parsed', { file: p, detail: e.message, portal: 'Blocks' }); return null; }
  const servers = m.mcpServers || m;
  const out = [];
  for (const [name, s] of Object.entries(servers)) {
    if (typeof s !== 'object' || !s) continue;
    out.push({ name, ...s });
    if (s.url != null) {
      if (s.url !== '' && !/^(https|wss):\/\//.test(s.url) && !/^\$\{user_config\./.test(s.url)) F.add('FAIL', 'MCP', `MCP server "${name}" URL is not https`, { file: p, detail: s.url, portal: 'Blocks' });
      if (!s.type) F.add('FAIL', 'MCP', `Remote MCP server "${name}" needs type http, sse or ws`, { file: p, portal: 'Blocks' });
    }
    for (const [hk, hv] of Object.entries(s.headers || {})) {
      if (typeof hv === 'string' && !/\$\{user_config\./.test(hv) && /auth|key|token/i.test(hk)) F.add('FAIL', 'MCP', `Credential in MCP server "${name}" headers`, { file: p, detail: hk, portal: 'Blocks ("Secret in MCP headers")', fix: 'Use a userConfig entry with sensitive: true and ${user_config.KEY}.' });
      if (typeof hv === 'string' && /\$\{?[A-Z_]*(TOKEN|KEY|SECRET)/.test(hv) && !/user_config/.test(hv)) F.add('WARN', 'MCP', `MCP server "${name}" sends an environment credential`, { file: p, detail: `${hk}: ${hv}`, portal: 'Held for a reviewer ("Uses a credential from the user\'s machine")' });
    }
    if (s.command) {
      const c = [s.command, ...(s.args || [])].join(' ');
      if (/^(npx|uvx|bunx)$/.test(s.command) || /\b(pnpm|yarn) dlx\b|\bpipx run\b|\buv run\b/.test(c)) {
        const pinned = /@\d+\.\d+\.\d+(\s|$)|==\d+\.\d+\.\d+|--locked|--frozen/.test(c);
        F.add(pinned ? 'WARN' : 'FAIL', 'MCP', pinned ? `MCP server "${name}" runs a pinned package from a registry` : `MCP server "${name}" runs an unpinned package`, { file: p, detail: c, portal: pinned ? 'Held for a reviewer' : 'Blocks ("Unpinned npx/uvx launcher")' });
      }
      if (/^(sh|bash|cmd|powershell|pwsh)(\.exe)?$/.test(s.command) || (s.args || []).some(a => /^(-c|\/c|-Command|-e|--eval)$/.test(a)) || /^(npm|yarn|pnpm)$/.test(s.command))
        F.add('WARN', 'MCP', `MCP server "${name}" starts through a shell, inline program or package script`, { file: p, detail: c, portal: 'Held for a reviewer ("MCP server command wasn\'t read")' });
      if (/\.(mcpb|dxt)\b/.test(c)) F.add('WARN', 'MCP', `MCP server "${name}" is a bundle`, { file: p, portal: 'Held for a reviewer' });
    }
  }
  const base = ctx.pluginDir ? ctx.pluginDir + '/' : '';
  for (const rc of ['.npmrc', 'bunfig.toml', 'uv.toml', '.yarnrc', '.yarnrc.yml', 'pip.conf'])
    if (ctx.files.has(base + rc)) F.add('WARN', 'MCP', `Package-manager config ${rc} in the plugin`, { file: base + rc, portal: 'Blocks with a launcher; held with an install' });
  if (ctx.files.has(base + 'package.json') && ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lock', 'bun.lockb'].some(l => ctx.files.has(base + l)))
    F.add('WARN', 'MCP', 'package.json with a lockfile at the plugin root', { portal: 'Held for a reviewer ("Dependencies install from a lockfile")' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// README: listing text, sections, prompts, sample data, docs traps
export function checkReadme(ctx, F) {
  const { files, pluginDir } = ctx;
  const base = pluginDir ? pluginDir + '/' : '';
  const cands = [...files.keys()].filter(p => p.startsWith(base) && /^readme(\.md|\.markdown|\.txt)?$/i.test(p.slice(base.length)));
  const p = cands.find(x => /README\.md$/.test(x)) || cands[0];
  if (!p) { F.add('FAIL', 'README', 'No README in the plugin folder', { portal: 'Blocks ("README missing")', fix: 'Add README.md (at least 40 words outside code blocks) to the plugin folder; the directory shows it as the listing.' }); return null; }
  const text = files.get(p).data.toString('utf8');
  const readme = { path: p, text };
  // Only images and fonts that ship in the plugin folder matter for the "could run" hold.
  const bundledNames = new Set([...files.keys()].filter(f => f.startsWith(base) && (R.IMAGE_EXT.test(f) || R.FONT_EXT.test(f))).map(f => f.split('/').pop().toLowerCase()));
  const bundled = ref => bundledNames.has(ref.replace(/\\/g, '/').split('/').pop().toLowerCase());
  const wc = words(text);
  if (wc < 40) F.add('FAIL', 'README', 'README is under 40 words outside code blocks', { file: p, detail: `${wc} words`, portal: 'Blocks ("README too short")' });
  else F.add('PASS', 'README', 'README found', { file: p, detail: `${wc} words outside code blocks` });
  const hs = headings(text);
  const want = [
    [/privacy/i, 'Privacy', 'WARN', '3A', 'what it collects, sends and keeps; the privacyPolicyUrl can point at this heading'],
    [/support|contact|issues|help/i, 'Support', 'WARN', '3B', 'where to report problems (GitHub issues) and security concerns'],
    [/what (it|this plugin|the plugin) (runs|reads|writes|sends|does)|runs, (reads|sends)|reads and writes|what it (reads|writes)|how it works|data/i, 'What it runs, reads and writes', 'WARN', '3C', 'every program it starts, file it reads or writes, and request it sends'],
    [/where it works|requirements|compatib|platforms?|surfaces/i, 'Where it works', 'WARN', null, 'which surfaces (Claude Code, Cowork, chat) and OS it needs'],
    [/troubleshoot|problems|faq|if something goes wrong|known issues/i, 'Troubleshooting', 'WARN', '3C', 'how users fix common problems'],
  ];
  readme.sections = {};
  for (const [re, label, sev, pol, why] of want) {
    const h = hs.find(x => re.test(x.text));
    if (!h) F.add(sev, 'README-SECTION', `README has no "${label}" section`, { file: p, policy: pol || undefined, detail: why });
    else readme.sections[label] = h.text;
  }
  // Example prompts (3E).
  const ex = examplePrompts(text);
  readme.prompts = ex.prompts;
  if (ex.prompts.length >= 3) F.add('PASS', 'PROMPTS', `${ex.prompts.length} example prompts found`, { file: p, line: ex.line, policy: '3E', detail: ex.prompts.slice(0, 5).map(x => `• ${x}`).join('\n') });
  else F.add('FAIL', 'PROMPTS', `Fewer than 3 example prompts found (${ex.prompts.length})`, { file: p, line: ex.line || undefined, policy: '3E', detail: ex.heading ? `Under "${ex.heading}".` : 'No heading like "Example prompts" was found.', fix: 'Add an "Example prompts" section with at least three prompts in a code block, each tested on the sample data.' });
  // Sample / test data (3D).
  const sampleDirs = [...new Set([...files.keys()].filter(f => f.startsWith(base)).map(f => f.slice(base.length)).filter(f => /(^|\/)(samples?|examples?|fixtures|test-?data|demo)\//i.test(f)).map(f => f.split('/').slice(0, f.split('/').findIndex(s => /^(samples?|examples?|fixtures|test-?data|demo)$/i.test(s)) + 1).join('/')))];
  const sampleSec = hs.find(x => /sample|for reviewers|test (account|data|setup)|try it|demo/i.test(x.text));
  readme.sampleDirs = sampleDirs; readme.sampleSection = sampleSec?.text || null;
  if (sampleDirs.length && sampleSec) F.add('PASS', 'SAMPLE', 'Sample data and a README section about it', { detail: `${sampleDirs.join(', ')}; "${sampleSec.text}"`, policy: '3D' });
  else if (sampleDirs.length || sampleSec) F.add('WARN', 'SAMPLE', sampleDirs.length ? 'Sample data found, but no README section tells reviewers how to use it' : 'README mentions samples or reviewers, but no sample folder is in the plugin', { file: p, policy: '3D', detail: sampleDirs.join(', ') || sampleSec.text, fix: 'Add a "Try it with the sample" or "For reviewers" section that names the files and what a run should show.' });
  else F.add('WARN', 'SAMPLE', 'No sample or test data for reviewers', { file: p, policy: '3D', detail: 'Policy 3D asks for a testing account with sample data. For a local tool, ship a small sample (or a script that makes one) and say what a run reports.', fix: 'Add samples/ and a "For reviewers" section.' });
  // Docs traps from history.
  const plain = text;
  for (const m of plain.matchAll(/`(https?:\/\/[^`\s]+)`/g))
    F.add('WARN', 'README-URL', 'URL in backticks', { file: p, line: lineOf(plain, m.index), detail: `${m[1]}. The directory auto-filled Lore Lookup's documentation link from a backticked URL and kept the closing backtick.`, fix: 'Write it as a Markdown link, and set documentationUrl in plugin.json.' });
  const codeBlocks = [...text.matchAll(/(^|\n)(```|~~~)[^\n]*\n([\s\S]*?)\n\2/g)];
  for (const cb of codeBlocks) {
    const body = cb[3];
    const at = lineOf(text, cb.index + cb[1].length) + 1;
    for (const [re, why] of R.DOWNLOAD_RUN) { const m = body.match(re); if (m) F.add('WARN', 'DOWNLOAD-RUN', `Download-and-run command in the README: ${why}`, { file: p, line: at + lineOf(body, m.index) - 1, detail: m[0].slice(0, 140), portal: 'Held for a reviewer ("Contains a download-and-run command")', fix: 'Split it: clone (or download) in one block, then run the installer in the next, and say what it does.' }); }
    if (/git clone/.test(body) && /\n\s*(node|python3?|py|bash|sh|powershell|pwsh|\.\/|\.\\)\S*\s+\S*(install|setup)/i.test(body))
      F.add('WARN', 'DOWNLOAD-RUN', 'One code block both clones and runs an installer', { file: p, line: at, portal: 'Held for a reviewer ("Contains a download-and-run command")', fix: 'Put the clone and the install in separate blocks (Lore Lookup\'s fix).' });
    for (const asset of body.matchAll(/[\w./\\-]+\.(png|jpe?g|gif|webp|svg|ico|ttf|otf|woff2?)\b/gi)) {
      if (!bundled(asset[0])) continue;
      F.add('WARN', 'ASSET-REF', 'Bundled image or font file named in a code block', { file: p, line: at + lineOf(body, asset.index) - 1, detail: asset[0], portal: 'Held for a reviewer ("Image or font file the plugin\'s code could run")', fix: 'Show images with Markdown image syntax only; don\'t name bundled image or font paths in code.' });
      break;
    }
  }
  for (const m of stripCode(text).matchAll(/`([^`\n]+\.(png|jpe?g|gif|webp|svg|ttf|otf|woff2?))`/gi))
    if (bundled(m[1])) F.add('WARN', 'ASSET-REF', 'Bundled image or font path in backticks', { file: p, line: lineOf(text, m.index), detail: m[1], portal: 'Held for a reviewer' });
  if (/\b(official (anthropic|claude)|by anthropic|endorsed by anthropic|anthropic['’]s official)\b/i.test(text) && !/\bunofficial\b|not (affiliated|endorsed)/i.test(text))
    F.add('WARN', 'OFFICIAL', 'README could read as an official Anthropic product', { file: p, fix: 'Add a one-line note that this is an independent project, not made or endorsed by Anthropic.' });
  return readme;
}

// ---------------------------------------------------------------------------------------------
// Code: injection, credentials, environment, side effects (for README-vs-code), chat history
export function checkCode(ctx, F, readme) {
  const { files, pluginDir, allow } = ctx;
  const base = pluginDir ? pluginDir + '/' : '';
  const rtext = readme?.text || '';
  const evidence = Object.fromEntries(R.SIDE_EFFECTS.map(s => [s.id, []]));
  const hosts = new Map();
  const envReads = [];
  const chatHits = [];
  const isInstr = p => /(^|\/)(SKILL\.md|commands\/.+\.md|agents\/.+\.md)$/.test(p);
  const bundledImages = new Set([...files.keys()].filter(f => f.startsWith(base) && R.IMAGE_EXT.test(f)).map(f => f.split('/').pop().toLowerCase()));
  for (const [p, f] of files) {
    if (!p.startsWith(base) || !isText(f.data)) continue;
    const isCode = R.CODE_EXT.test(p);
    const instr = isInstr(p);
    const isTest = R.TEST_PATH.test(p);
    if (!isCode && !instr && !/hooks\.json$|\.mcp\.json$/.test(p)) continue;
    const text = f.data.toString('utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const ln = i + 1;
      const trimmed = line.trim();
      const isComment = /^(\/\/|#|<#|\*|::|rem\b|REM\b)/.test(trimmed);
      // Real secrets: everywhere, comments included.
      for (const [re, what] of R.SECRET_SHAPES) if (re.test(line)) F.add('FAIL', 'SECRET', `Looks like a real ${what}`, { file: p, line: ln, portal: 'Blocks', fix: 'Remove it, rotate it, and rewrite history if it was ever pushed.' });
      if (isComment && !instr) return;
      if (isCode) {
        if (!isTest) for (const [re, label, ext] of R.INJECTION) if (ext.test(p) && re.test(line)) {
          // Shell variables checked earlier with [[ $v =~ ... ]] or case $v in ... count as validated.
          // For sed, only the variables inside the sed program matter.
          const scope = /sed/.test(label) ? (line.match(/\bsed\b[^|]*?(["'])((?:(?!\1).)*\$(?:(?!\1).)*)\1/) || [])[2] || line : line;
          const vars = [...new Set([...scope.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9])\}?/g)].map(m => m[1]))];
          const guardOf = v => { const re = new RegExp(`(\\[\\[\\s*"?\\$\\{?${v}\\}?"?\\s*=~|case\\s+"?\\$\\{?${v}\\}?"?\\s+in)`); return lines.slice(0, i).findIndex(l => re.test(l)); };
          const guards = vars.map(guardOf);
          if (vars.length && guards.every(g => g >= 0)) F.add('INFO', 'INJECTION', `Checked: ${label}`, { file: p, line: ln, detail: `${trimmed.slice(0, 140)}\n${vars.map((v, k) => `$${v} is validated at line ${guards[k] + 1}`).join('; ')} first.` });
          else F.add('WARN', 'INJECTION', `Shell-injection risk: ${label}`, { file: p, line: ln, detail: trimmed.slice(0, 160), fix: 'Pass arguments as an array with no shell, validate inputs (e.g. numbers must be whole numbers), and quote every expansion.' });
        }
        if (R.SHELL_EXT.test(p) && /\$'[^']*\\[nrt]/.test(line)) F.add('INFO', 'ANSI-C', 'ANSI-C quoting ($\'…\')', { file: p, line: ln, detail: 'Both Ablation Lab privacy checks swapped this for printf -v while clearing directory holds. Harmless, but reads as obfuscated to some scanners.' });
        const cl = line.match(R.CREDENTIAL_LOOKALIKE);
        if (cl) F.add('WARN', 'CREDENTIAL-NAME', `Identifier that looks like a credential: ${cl[0]}`, { file: p, line: ln, portal: 'Held for a reviewer ("Uses a credential from the user\'s machine")', detail: 'Lore Lookup (LOCK_TOKEN) and Cutproof (TokA/TokB, $key) were held for names like this; renaming cleared it.', fix: 'Rename it to say what it is (e.g. lockId).' });
        if (!isTest) for (const re of R.ENV_READ) {
          if (re.source.startsWith('%') && !R.BATCH_EXT.test(p)) continue;
          if (re === R.ENV_READ[R.ENV_READ.length - 1] && !R.SHELL_EXT.test(p)) continue;
          for (const m of line.matchAll(re)) {
            const v = m[1] || m[2];
            if (!v || R.ENV_ALLOWED.test(v) || /^~?[0-9]/.test(v)) continue;
            if (R.SHELL_EXT.test(p) && /^(HOME|PWD|OLDPWD|USER|SHELL|TERM|LANG|LC_[A-Z_]+|IFS|BASH[A-Z_]*|RANDOM|LINENO|SECONDS|UID|EUID|PPID|HOSTNAME|OSTYPE|TMPDIR|EDITOR|PAGER|OPTARG|OPTIND)$/.test(v)) continue;
            envReads.push({ file: p, line: ln, name: v });
          }
        }
        if (/\bdownload\b/i.test(line) && /https?:\/\//.test(line) && !/^\s*(import|from|require)/.test(line))
          F.add('WARN', 'DOWNLOAD-URL', 'Message or code points users to a download URL', { file: p, line: ln, detail: trimmed.slice(0, 160), fix: 'Point to the README instead (Cutproof\'s ffmpeg message did this to clear a hold).' });
        if (/--dangerously-skip-permissions|bypassPermissions|"defaultMode"\s*:|permissions\s*\.\s*allow|"allow"\s*:\s*\[/.test(line))
          F.add('FAIL', 'PERMISSIONS', 'Code that changes Claude\'s permission settings', { file: p, line: ln, detail: trimmed.slice(0, 160), fix: 'Plugins must not change permission settings; the security scan rejects it.' });
      }
      // Font files anywhere in code, and bundled images, read as files "the plugin's code could run".
      // Cutproof's sample script named arialbd.ttf; Lore Lookup's test opened its icon. Both were held.
      if (isCode) for (const am of line.matchAll(/[\w.-]+\.(ttf|otf|woff2?|png|jpe?g|gif|webp|svg|ico)\b/gi)) {
        const n = am[0].toLowerCase();
        if (/\.(ttf|otf|woff2?)$/.test(n) || bundledImages.has(n)) {
          F.add('WARN', 'CODE-ASSET', `Code names ${/\.(ttf|otf|woff2?)$/.test(n) ? 'a font file' : 'a bundled image'}: ${am[0]}`, { file: p, line: ln, portal: 'Held for a reviewer ("Image or font file the plugin\'s code could run")', fix: 'Don\'t open or name image or font files from scripts or tests; Cutproof switched to a system font by family name.' });
          break;
        }
      }
      if (isTest) return;
      for (const eff of R.SIDE_EFFECTS) if (eff.code.test(line)) evidence[eff.id].push({ file: p, line: ln, text: trimmed.slice(0, 140) });
      for (const m of line.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(:\d+)?/gi)) {
        const h = m[1].toLowerCase();
        if (/^(example\.(com|org|net)|localhost|127\.0\.0\.1|schemas?\.[a-z.]+|json-schema\.org|www\.w3\.org)$/.test(h)) continue;
        if (!hosts.has(h)) hosts.set(h, { file: p, line: ln });
      }
      for (const [re, what, sev] of R.CHAT_HISTORY) if (re.test(line)) chatHits.push({ file: p, line: ln, what, sev, text: trimmed.slice(0, 140), instr });
    });
  }
  // Environment variable reads.
  const byName = new Map();
  for (const r of envReads) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
  for (const [name, rs] of byName) {
    const at = `${rs[0].file}:${rs[0].line}` + (rs.length > 1 ? ` (+${rs.length - 1} more)` : '');
    if (R.ENV_CREDENTIAL.test(name)) F.add('WARN', 'ENV-CREDENTIAL', `Reads a credential-like environment variable: ${name}`, { file: rs[0].file, line: rs[0].line, detail: at, portal: 'Held for a reviewer ("Uses a credential from the user\'s machine"); blocks for an HTTP hook that sends it', fix: 'Ask for it through a userConfig entry with sensitive: true.' });
    else if (R.ENV_PATHLIKE.test(name)) F.add('WARN', 'ENV-PATH', `Finds a folder through an environment variable: ${name}`, { file: rs[0].file, line: rs[0].line, detail: at + '. Cutproof cleared a hold by switching to [Environment]::GetFolderPath; in Node use os.homedir()/os.tmpdir().', fix: 'Use the platform API for known folders.' });
    else F.add('WARN', 'ENV-OTHER', `Reads environment variable ${name}`, { file: rs[0].file, line: rs[0].line, detail: at + '. A setting read from the environment (SessionKeeper\'s SESSIONKEEPER_EXE) was part of what the scan held; prefer a fixed location or userConfig, and document it.', fix: 'Document it in the README, or replace it with userConfig.' });
  }
  // Chat history and summaries (1G).
  const fails = chatHits.filter(h => h.sev === 'FAIL'), warns = chatHits.filter(h => h.sev === 'WARN');
  const fmt = hs => hs.slice(0, 6).map(h => `${h.file}:${h.line} (${h.what}) ${h.text}`).join('\n');
  if (fails.length) F.add('FAIL', 'CHAT-HISTORY', 'Reads chat history, transcripts, memory or conversation summaries', { file: fails[0].file, line: fails[0].line, policy: '1G', detail: fmt(fails), fix: 'Policy 1G: software must not query or extract data from Claude\'s memory, chat history or conversation summaries. If this is local-only metadata (e.g. titles) and core to the plugin, say exactly what is read and what never leaves the machine in a "For reviewers" section — and expect a reviewer to decide.' });
  if (warns.length) F.add('WARN', 'CHAT-HISTORY', 'Touches session state or mentions transcripts', { file: warns[0].file, line: warns[0].line, policy: '1G', detail: fmt(warns) + '\nCheck by reading the code: listing running sessions is different from reading what was said in them.' });
  // What the docs say the plugin (or the app it drives) reads.
  const docHits = [];
  const docFiles = [readme?.path, ...[...files.keys()].filter(p => p.startsWith(base) && isInstr(p))].filter(Boolean);
  for (const dp of [...new Set(docFiles)]) {
    const t = files.get(dp)?.data.toString('utf8') || '';
    for (const sentence of t.split(/(?<=[.!?])\s+|\n(?=\s*[-*] )/)) {
      if (!/\b(reads?|reading|scans?|parses?|opens?|loads?|looks? (at|in)|uses?|lists?|finds?)\b/i.test(sentence)) continue;
      for (const [re, what, sev] of R.CHAT_HISTORY) {
        const m = sentence.match(re);
        if (!m) continue;
        const before = sentence.slice(0, m.index);
        if (/\b(never|not|doesn't|does not|don't|no|without|nor|instead of)\b[^,;]*$/i.test(before)) continue;
        docHits.push({ file: dp, line: lineOf(t, t.indexOf(sentence)), what, sev, text: sentence.trim().slice(0, 200) });
        break;
      }
    }
  }
  const docFails = docHits.filter(h => h.sev === 'FAIL');
  if (docFails.length && !fails.length) F.add('FAIL', 'CHAT-HISTORY', 'The docs say it reads chat history, transcripts or conversation summaries', { file: docFails[0].file, line: docFails[0].line, policy: '1G', detail: docFails.slice(0, 4).map(h => `${h.file}:${h.line} (${h.what}) ${h.text}`).join('\n') + '\nThe code doing it may be outside the plugin folder (an app the plugin starts); its behaviour still counts.', fix: 'Policy 1G forbids querying chat history and conversation summaries (auto-generated titles count). If only local metadata is read and it never reaches Claude, explain exactly that for reviewers — and expect a reviewer decision, possibly a rejection.' });
  else if (docHits.length && !fails.length && !warns.length) F.add('WARN', 'CHAT-HISTORY', 'The docs mention reading Claude Code session data', { file: docHits[0].file, line: docHits[0].line, policy: '1G', detail: docHits.slice(0, 4).map(h => `${h.file}:${h.line} (${h.what}) ${h.text}`).join('\n') });
  if (!fails.length && !warns.length && !docHits.length) F.add('PASS', 'CHAT-HISTORY', 'No reads of chat history, transcripts, memory or summaries found', { policy: '1G' });
  // Companion code outside the plugin folder (e.g. an app the plugin starts). Not shipped, but its
  // behaviour is the plugin's behaviour when the plugin runs it.
  if (base) {
    const comp = { chat: [], effects: {} };
    for (const [p, f] of files) {
      if (p.startsWith(base) || R.TEST_PATH.test(p) || !R.CODE_EXT.test(p) || !isText(f.data)) continue;
      if (/(^|\/)(\.githooks|scripts\/privacy-check)/.test(p)) continue;
      f.data.toString('utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|#|\*)/.test(line)) return;
        for (const [re, what, sev] of R.CHAT_HISTORY) if (sev === 'FAIL' && re.test(line)) comp.chat.push({ file: p, line: i + 1, what, text: line.trim().slice(0, 120) });
        for (const eff of R.SIDE_EFFECTS) if (['registry', 'shortcut', 'autostart', 'network', 'claude-config'].includes(eff.id) && eff.code.test(line)) (comp.effects[eff.id] ||= []).push({ file: p, line: i + 1, text: line.trim().slice(0, 120) });
      });
    }
    if (comp.chat.length) F.add('WARN', 'COMPANION-1G', 'Code outside the plugin folder reads chat history or session summaries', { file: comp.chat[0].file, line: comp.chat[0].line, policy: '1G', detail: comp.chat.slice(0, 4).map(h => `${h.file}:${h.line} (${h.what}) ${h.text}`).join('\n') + '\nIf the plugin starts this code (an app or helper), reviewers will treat it as the plugin\'s behaviour.' });
    for (const [id, ev] of Object.entries(comp.effects)) {
      const eff = R.SIDE_EFFECTS.find(s => s.id === id);
      const mentioned = eff.readme.test(rtext);
      F.add(mentioned ? 'INFO' : 'WARN', 'COMPANION-EFFECT', `Code outside the plugin folder: ${eff.label}${mentioned ? ' (the plugin README mentions it)' : ' — not in the plugin README'}`, { file: ev[0].file, line: ev[0].line, detail: ev.slice(0, 3).map(e => `${e.file}:${e.line}  ${e.text}`).join('\n') + '\nOnly matters if the plugin starts this code; then disclose it in the plugin README.' });
    }
  }
  // README vs code.
  // (rtext is declared at the top of checkCode)
  const effects = [];
  for (const eff of R.SIDE_EFFECTS) {
    const ev = evidence[eff.id];
    if (!ev.length) continue;
    const mentioned = eff.readme.test(rtext);
    effects.push({ id: eff.id, label: eff.label, count: ev.length, mentioned, examples: ev.slice(0, 4) });
    const sev = mentioned ? 'INFO' : (['registry', 'shortcut', 'autostart', 'claude-config', 'network', 'home-files'].includes(eff.id) ? 'FAIL' : 'WARN');
    F.add(sev, 'DISCLOSE', `${mentioned ? 'Disclosed' : 'Not found in the README'}: ${eff.label}`, { file: ev[0].file, line: ev[0].line, policy: '2B, 3C', detail: ev.slice(0, 4).map(e => `${e.file}:${e.line}  ${e.text}`).join('\n') + (ev.length > 4 ? `\n(+${ev.length - 4} more)` : ''), portal: mentioned ? null : 'Security scan ("does something the README doesn\'t disclose")', fix: mentioned ? 'Check the README describes this accurately (where, when, how to undo).' : `Describe it in the README's "What it runs, reads and writes" section, or remove it.` });
  }
  for (const [h, at] of hosts) {
    if (!rtext.toLowerCase().includes(h)) F.add('WARN', 'DISCLOSE-HOST', `Host ${h} in the code isn't named in the README`, { file: at.file, line: at.line, policy: '2B, 3F', detail: 'List every domain the plugin contacts or tells Claude to fetch.', portal: 'Security scan ("Sends data to an undisclosed destination") if contacted' });
  }
  for (const nc of R.NEGATIVE_CLAIMS) {
    const m = rtext.match(nc.re);
    const after = m ? rtext.slice(m.index + m[0].length, m.index + m[0].length + 60) : '';
    const qualified = /^.{0,40}\b(it didn't|it did not|that it|it doesn't own|other than|except|of its own|outside (its|the)|unless)\b/i.test(after);
    if (m && !qualified && evidence[nc.effect].length) F.add('WARN', 'CLAIM-CHECK', `README says "${m[0]}" but the code has ${R.SIDE_EFFECTS.find(s => s.id === nc.effect).label}`, { file: readme.path, line: lineOf(rtext, m.index), policy: '2B', detail: evidence[nc.effect].slice(0, 3).map(e => `${e.file}:${e.line}  ${e.text}`).join('\n'), fix: 'Read the code: either the claim needs a qualifier (e.g. "the plugin… ; the app it opens…") or the code is wrong.' });
  }
  // Unsupported use cases (4).
  const allText = `${rtext}\n${ctx.manifest?.description || ''}`;
  for (const [re, what] of R.UNSUPPORTED) { const m = allText.match(re); if (m) F.add('INFO', 'POLICY-4', `Mentions something in an unsupported category: ${what}`, { policy: '4', detail: `"${m[0]}" — only a prompt to check; most mentions are harmless.` }); }
  return { effects, hosts: [...hosts.keys()], envReads: [...byName.keys()] };
}

// ---------------------------------------------------------------------------------------------
// Unicode in every text file
export function checkUnicode(ctx, F) {
  const { files, pluginDir } = ctx;
  const base = pluginDir ? pluginDir + '/' : '';
  let scanned = 0, total = 0;
  for (const [p, f] of files) {
    if (!isText(f.data)) continue;
    scanned++;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(f.data); }
    catch { F.add('WARN', 'UNICODE-UTF8', 'File is not valid UTF-8', { file: p }); continue; }
    const inPlugin = p.startsWith(base);
    const instr = /(^|\/)(SKILL\.md|commands\/.+\.md|agents\/.+\.md|README\.md|plugin\.json|hooks\.json|\.mcp\.json)$/i.test(p);
    const hits = scanUnicode(text);
    const hidden = hits.filter(h => h.kind === 'hidden'), odd = hits.filter(h => h.kind === 'odd');
    total += hits.length;
    if (hidden.length) {
      const tag = decodeTagRun(text);
      F.add(inPlugin ? 'FAIL' : 'WARN', 'UNICODE-HIDDEN', `Hidden characters (${hidden.length})`, { file: p, line: hidden[0].line, policy: instr ? '2G' : undefined,
        detail: hidden.slice(0, 6).map(h => `line ${h.line} col ${h.col}: ${h.code} ${h.name}`).join('\n') + (tag ? `\nTag characters spell: "${tag.slice(0, 120)}"` : ''),
        fix: 'Delete them. If the code must contain one (e.g. a sanitiser), write it as a \\u escape, as Lore Lookup does.' });
    }
    if (odd.length) F.add(inPlugin && instr ? 'WARN' : 'INFO', 'UNICODE-ODD', `Unusual characters (${odd.length})`, { file: p, line: odd[0].line,
      detail: [...new Set(odd.map(h => `${h.code} ${h.name}`))].slice(0, 5).join(', ') + ` — first at line ${odd[0].line} col ${odd[0].col}`, fix: 'Usually harmless (no-break spaces pasted from a web page); replace with plain spaces or hyphens.' });
    if (inPlugin) for (const w of mixedScriptWords(text).slice(0, 3)) {
      const { line, col } = lineColAt(text, w.index);
      F.add(instr ? 'FAIL' : 'WARN', 'UNICODE-HOMOGLYPH', `Word mixes ${w.scripts.join(' and ')} letters: "${w.word}"`, { file: p, line, detail: `col ${col}. Look-alike letters can disguise names and instructions.`, policy: instr ? '2G' : undefined });
    }
    if (f.data[0] === 0xEF && f.data[1] === 0xBB && f.data[2] === 0xBF && /\.(json|sh|mjs|js|py)$/.test(p)) F.add('WARN', 'UNICODE-BOM', 'File starts with a byte order mark', { file: p, detail: 'Some JSON parsers and shells choke on it.' });
  }
  if (!F.list.some(x => x.id.startsWith('UNICODE-'))) F.add('PASS', 'UNICODE', 'No hidden or unusual Unicode characters', { detail: `${scanned} text files scanned.` });
}

// ---------------------------------------------------------------------------------------------
// Personal data: emails in files and history, private terms, local paths
export function checkPersonal(ctx, F) {
  const { files, identities, addedLines, privateTerms } = ctx;
  const emailHits = new Map();
  for (const [p, f] of files) {
    if (!isText(f.data)) continue;
    const text = f.data.toString('utf8');
    for (const m of text.matchAll(R.EMAIL)) {
      const e = m[0].replace(/\.$/, '');
      if (R.SAFE_EMAIL.test(e) || /\.(png|jpe?g|svg|gif|webp)$/i.test(e) || /^[0-9a-f]{7,}@/.test(e)) continue;
      // user:password@host inside a URL is not an email address.
      if (/:\/\/[^\s/]*:?$/.test(text.slice(Math.max(0, m.index - 80), m.index)) || text[m.index - 1] === ':') continue;
      const k = `${p}|${e}`;
      if (!emailHits.has(k)) emailHits.set(k, { file: p, line: lineOf(text, m.index), email: e });
    }
    const lp = text.match(R.LOCAL_USER_PATH);
    if (lp) F.add('WARN', 'LOCAL-PATH', 'Path with a local user name', { file: p, line: lineOf(text, lp.index), detail: lp[0].replace(/(Users[\\/]+|home\/)([^\\/]{2})[^\\/]*/i, '$1$2…'), fix: 'Use a placeholder like C:\\Users\\<you> or ~.' });
    for (const t of privateTerms) {
      const m = text.match(t.re);
      if (m) F.add('FAIL', 'PRIVATE-TERM', `Private term from your list (pattern ${t.n})`, { file: p, line: lineOf(text, m.index), detail: `${t.source} (${t.file})`, fix: 'Remove it.' });
    }
  }
  for (const h of emailHits.values()) {
    const domain = h.email.split('@')[1];
    const personal = R.PERSONAL_WEBMAIL.test(domain);
    F.add(personal ? 'FAIL' : 'WARN', 'EMAIL-FILE', personal ? 'Personal email address in a file' : 'Email address in a file', { file: h.file, line: h.line, detail: `${maskEmail(h.email)}${personal ? '' : ' — fine if it\'s a public contact address you mean to publish'}`, fix: 'Use your GitHub noreply address or a project contact address.' });
  }
  // Commit identities.
  const bad = new Map();
  for (const c of identities) {
    for (const [role, e] of [['author', c.author], ['committer', c.committer]]) {
      if (!e || /@users\.noreply\.github\.com$/i.test(e) || /^noreply@github\.com$/i.test(e)) continue;
      const k = `${role}|${e}`; if (!bad.has(k)) bad.set(k, { role, email: e, commits: [] }); bad.get(k).commits.push(c.sha.slice(0, 7));
    }
    for (const e of c.coAuthors) if (!R.SAFE_EMAIL.test(e) && R.PERSONAL_WEBMAIL.test(e.split('@')[1] || ''))
      F.add('FAIL', 'EMAIL-HISTORY', 'Personal email in a Co-authored-by trailer', { detail: `${maskEmail(e)} in ${c.sha.slice(0, 7)}` });
  }
  if (bad.size) for (const b of bad.values()) {
    const personal = R.PERSONAL_WEBMAIL.test(b.email.split('@')[1] || '');
    F.add('FAIL', 'EMAIL-HISTORY', `${personal ? 'Personal' : 'Non-noreply'} email as commit ${b.role}`, { detail: `${maskEmail(b.email)} in ${b.commits.length} commit(s): ${b.commits.slice(0, 6).join(', ')}${b.commits.length > 6 ? ' …' : ''}`, fix: 'Set git config user.email to your <id>+<user>@users.noreply.github.com address. Rewriting published history needs care (filter-branch/filter-repo, then force-push).' });
  }
  else if (identities.length) F.add('PASS', 'EMAIL-HISTORY', 'Every commit uses a GitHub noreply address', { detail: `${identities.length} commits checked.` });
  // History content: personal emails and private terms that were removed later still ship on GitHub.
  const seen = new Set();
  for (const l of addedLines) {
    for (const m of l.text.matchAll(R.EMAIL)) {
      const e = m[0];
      if (R.SAFE_EMAIL.test(e) || !R.PERSONAL_WEBMAIL.test(e.split('@')[1] || '')) continue;
      const k = `e|${e}|${l.file}`; if (seen.has(k)) continue; seen.add(k);
      if ([...emailHits.values()].some(h => h.email === e && h.file === l.file)) continue;
      F.add('FAIL', 'EMAIL-HISTORY', 'Personal email in an earlier commit\'s content', { file: l.file, detail: `${maskEmail(e)} added in ${l.sha}; still in the repo's history even though the current files don't have it.`, fix: 'Rewrite history to remove it before the repo goes public.' });
    }
    for (const t of privateTerms) {
      if (!t.re.test(l.text)) continue;
      const k = `t|${t.n}|${l.file}`; if (seen.has(k)) continue; seen.add(k);
      F.add('FAIL', 'PRIVATE-TERM-HISTORY', `Private term (pattern ${t.n}) in an earlier commit`, { file: l.file, detail: `added in ${l.sha}`, fix: 'Rewrite history to remove it.' });
    }
  }
}
