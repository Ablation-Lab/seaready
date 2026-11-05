// Name-clash lookup against the plugin directory, offline.
// Claude Code keeps a local copy of the directory's listings in
// ~/.claude/plugins/plugin-directory-cache-v2.json (refreshed when you browse /plugin), and each
// added marketplace is cloned under ~/.claude/plugins/marketplaces/. Both are read only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function loadListings(configDir) {
  const base = configDir || path.join(os.homedir(), '.claude');
  const sources = [];
  const items = [];
  const cacheFile = path.join(base, 'plugins', 'plugin-directory-cache-v2.json');
  try {
    const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const names = d.entryNames || {}, claims = d.entryNameClaims || {};
    for (const l of d.listings || []) {
      items.push({ name: names[l.id] || '', displayName: l.name || '', repo: claims[l.id]?.repositoryKey || l.source?.repository?.url || '',
        summary: l.summary || '', origin: 'directory' });
    }
    sources.push({ file: cacheFile, fetchedAt: d.fetchedAt || null, count: (d.listings || []).length });
  } catch { /* no cache: reported by the caller */ }
  const mpDir = path.join(base, 'plugins', 'marketplaces');
  let mps = [];
  try { mps = fs.readdirSync(mpDir); } catch { /* none */ }
  for (const mp of mps) {
    const f = path.join(mpDir, mp, '.claude-plugin', 'marketplace.json');
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const p of m.plugins || []) {
        const src = typeof p.source === 'string' ? p.source : (p.source?.repo || p.source?.url || '');
        items.push({ name: p.name || '', displayName: p.displayName || '', repo: `${mp}:${src}`, summary: p.description || '', origin: `marketplace ${mp}` });
      }
      sources.push({ file: f, fetchedAt: null, count: (m.plugins || []).length });
    } catch { /* skip unreadable */ }
  }
  return { items, sources };
}

// ownRepoKey like "github.com/owner/repo" (lowercase) so our own listing isn't reported as a clash.
export function findClashes(listings, { name, displayName }, ownRepoKey) {
  const exact = [], similar = [];
  const n = norm(name), dn = norm(displayName);
  const own = it => ownRepoKey && it.repo && it.repo.toLowerCase().replace(/^https?:\/\//, '').replace(/\.git$/, '').startsWith(ownRepoKey);
  const seen = new Set();
  for (const it of listings.items) {
    const key = `${it.name}|${it.displayName}|${it.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cands = [norm(it.name), norm(it.displayName)].filter(Boolean);
    const isOwn = own(it);
    if (cands.some(c => c === n || (dn && c === dn))) { (isOwn ? similar : exact).push({ ...it, own: isOwn, how: 'same name' }); continue; }
    for (const c of cands) {
      for (const mine of [n, dn].filter(Boolean)) {
        if (mine.length < 4 || c.length < 4) continue;
        const d = lev(mine, c);
        if ((d <= 1 && mine.length >= 5) || (d <= 2 && mine.length >= 9)) { similar.push({ ...it, own: isOwn, how: `one or two letters apart (${c})` }); break; }
        if (c.length >= 5 && mine.length >= 5 && (c.includes(mine) || mine.includes(c))) { similar.push({ ...it, own: isOwn, how: `contains "${c.length < mine.length ? c : mine}"` }); break; }
      }
    }
  }
  return { exact, similar: similar.slice(0, 12) };
}

// Listings whose summaries share many distinctive words with ours (policy 2C overlap).
export function findOverlaps(listings, text, max = 6) {
  const STOP = new Set('the a an and or of to for in on with your you it its from by as at is are be this that their them into claude code plugin plugins skill skills use using when what how can also any all more each one'.split(' '));
  const words = s => new Set(String(s).toLowerCase().match(/[a-z][a-z-]{3,}/g)?.filter(w => !STOP.has(w)) || []);
  const mine = words(text);
  if (mine.size < 3) return [];
  const scored = [];
  for (const it of listings.items) {
    const w = words(`${it.displayName} ${it.summary}`);
    let common = 0; for (const x of w) if (mine.has(x)) common++;
    const score = common / Math.sqrt(Math.max(1, w.size) * mine.size);
    if (common >= 3 && score > 0.22) scored.push({ ...it, score: Math.round(score * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}
