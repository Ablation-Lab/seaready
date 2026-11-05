// Minimal reader for the tar format that `git archive --format=tar` writes (ustar + pax headers).
// Returns [{ path, type: 'file'|'dir'|'symlink'|'other', mode, data: Buffer, linkName }].

function str(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return (nul < 0 ? s : s.subarray(0, nul)).toString('utf8');
}

function octal(buf, start, len) {
  const s = str(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(32, pos);
    if (sp < 0) break;
    const len = Number(data.subarray(pos, sp).toString('utf8'));
    if (!len) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

export function readTar(buf) {
  const entries = [];
  let pos = 0;
  let pax = {};
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every(b => b === 0)) break;
    const name = str(header, 0, 100);
    const mode = octal(header, 100, 8);
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] || 48);
    const linkName = str(header, 157, 100);
    const prefix = str(header, 345, 155);
    const dataStart = pos + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (flag === 'g') continue;               // global header (git writes the commit id here)
    if (flag === 'x') { pax = parsePax(data); continue; }
    let path = pax.path || (prefix ? `${prefix}/${name}` : name);
    const link = pax.linkpath || linkName;
    pax = {};
    const type = flag === '0' || flag === '\0' ? 'file' : flag === '5' ? 'dir' : flag === '2' ? 'symlink' : 'other';
    if (type === 'dir') path = path.replace(/\/$/, '');
    entries.push({ path, type, mode, data, linkName: link });
  }
  return entries;
}
