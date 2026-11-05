// Regression tests for the second fix round (2026-11-05): the five regressions the recheck found in
// the follow-up fixes, and every README check run on CRLF line endings (the case that was missed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../plugin/skills/submission-check/scripts/check.mjs';
import { visibleText } from '../plugin/skills/submission-check/scripts/lib/checks.mjs';
import { repo, configDir, cleanPlugin, tmpDir } from './helpers.mjs';

const check = root => run({ repo: root, ref: 'HEAD', out: tmpDir('seaready-out-'), worktree: false, privateTerms: null, configDir: configDir(), validate: false, quiet: true, pluginPath: null });
const chat = (res, sev) => res.findings.some(x => x.id === 'CHAT-HISTORY' && x.sev === sev);
const homeHits = res => res.findings.filter(f => /files outside the project/.test(f.title) && ['FAIL', 'WARN'].includes(f.sev));
const CLAIM = 'It reads the session summary of each conversation and lists it.';
const crlf = s => s.replace(/\r?\n/g, '\r\n');

// 1. Comparison sections downgrade a chat-history claim only in the README, and only on a line that
// names another tool.
test('regression 1: an "Alternatives" heading in SKILL.md does not downgrade a chat-history claim', () => {
  const f = cleanPlugin();
  f['skills/quiet-notes/SKILL.md'] += '\n## Alternatives\n\nRead the session summary of each conversation and list it.\n';
  const res = check(repo(f));
  assert.ok(chat(res, 'FAIL'), 'an instruction in SKILL.md is what Claude does, whatever its heading');
  assert.ok(!chat(res, 'INFO'));
});

test('regression 1: a README comparison section downgrades only a line naming another tool', () => {
  const plain = cleanPlugin();
  plain['README.md'] += `\n## How it compares\n\n${CLAIM}\n`;
  assert.ok(chat(check(repo(plain)), 'FAIL'), 'no other tool named: still a FAIL');
  const own = cleanPlugin();
  own['README.md'] += '\n## How it compares\n\n- **Quiet Notes** reads the session summary of each conversation.\n';
  assert.ok(chat(check(repo(own)), 'FAIL'), "this plugin's own name: still a FAIL");
  const other = cleanPlugin();
  other['README.md'] += '\n## How it compares\n\n- **Focus Mode** reads the session summary of each conversation.\n- [Desk Timer](https://example.com/desk-timer) keeps a session summary too.\n';
  const res = check(repo(other));
  assert.ok(!chat(res, 'FAIL') && chat(res, 'INFO'), 'another named tool: INFO');
});

// 2. PowerShell home paths.
test('regression 2: PowerShell ~\\Documents and ~\\Desktop paths are home-folder paths', () => {
  for (const code of ["Get-ChildItem ~\\Documents\\notes\n", "Copy-Item notes.md ~\\Desktop\\\n", "Set-Content -Path ~\\source\\x.txt -Value 1\n"]) {
    const f = cleanPlugin();
    f['skills/quiet-notes/scripts/h.ps1'] = code;
    assert.ok(homeHits(check(repo(f))).length, code);
  }
});

// 3. CRLF code fences.
test('regression 3: in a CRLF README, an open comment inside a code fence hides nothing', () => {
  assert.match(visibleText('```\r\n<!-- not a comment\r\n```\r\nvisible after\r\n'), /visible after/);
  assert.match(visibleText('~~~md\r\n<!--\r\n~~~\r\nvisible after\r\n'), /visible after/);
  const f = cleanPlugin();
  f['README.md'] = f['README.md'].replace('## Privacy', '## Comment syntax\n\n```html\n<!-- start of a comment\n```\n\n## Privacy');
  const lf = check(repo(f)), cr = check(repo({ ...f, 'README.md': crlf(f['README.md']) }));
  assert.deepEqual(key(cr), key(lf));
});

// 4. Hidden comparison headings.
test('regression 4: a comparison heading inside a comment or a code fence opens no comparison section', () => {
  for (const wrap of [h => `<!--\n${h}\n-->`, h => `\`\`\`md\n${h}\n\`\`\``, h => `<!-- old -->\n<!--\n\n${h}\n\n-->`]) {
    const f = cleanPlugin();
    f['README.md'] += `\n${wrap('## Alternatives')}\n\n- **Focus Mode** reads the session summary of each conversation.\n`;
    const res = check(repo(f));
    assert.ok(chat(res, 'FAIL'), wrap('## Alternatives'));
  }
  // A visible heading after the section ends it, even one with a comment on its line.
  const g = cleanPlugin();
  g['README.md'] += '\n## How it compares\n\n- **Focus Mode** is a timer.\n\n## Usage <!-- x -->\n\n- **Focus Mode** reads the session summary of each conversation.\n';
  assert.ok(chat(check(repo(g)), 'FAIL'));
});

// 5. Lower-casing can change the length of the text.
test('regression 5: a Turkish İ before a <style> block hides nothing after it', () => {
  assert.match(visibleText('İstanbul İzmir İİİİİİİİ <style>p { color: red }</style> visible after'), /visible after/);
  assert.match(visibleText('İİİİİİİİİİİİ<SCRIPT>x</Script>visible after'), /visible after/);
  assert.match(visibleText('İİİİİİİİİİİİ<?php echo 1 ?>visible after'), /visible after/);
  const f = cleanPlugin();
  f['README.md'] = f['README.md'].replace('## Example prompts', 'Made in İstanbul and İzmir (İİİİİİİİİİİİİİİİ).\n\n<style>h1 { color: teal }</style>\n\n## Example prompts');
  const plain = cleanPlugin();
  plain['README.md'] = plain['README.md'].replace('## Example prompts', 'Made in Istanbul and Izmir (IIIIIIIIIIIIIIII).\n\n<style>h1 { color: teal }</style>\n\n## Example prompts');
  assert.deepEqual(key(check(repo(f))), key(check(repo(plain))));
});

// Every README check gives the same findings, on the same lines, whether the README uses LF or CRLF.
// Line-ending findings themselves are left out: those are meant to differ.
const key = res => res.findings.filter(x => !/^EOL-/.test(x.id)).map(x => `${x.sev} ${x.id} ${x.title} ${x.file || ''}:${x.line || ''}`).sort();
const fixtures = {
  clean: [f => f, null],
  'no privacy section': [f => { f['README.md'] = f['README.md'].replace(/## Privacy\n\n[^\n]*\n\n/, ''); return f; }, null],
  'two example prompts': [f => { f['README.md'] = f['README.md'].replace('Find the note about the build\n', ''); return f; }, ['FAIL', 'PROMPTS']],
  'undisclosed host': [f => { f['skills/quiet-notes/scripts/s.mjs'] = "await fetch('https://api.quiet-sync.example/notes', { method: 'POST' });\n"; return f; }, ['WARN', 'DISCLOSE-HOST']],
  '"no network" claim with network code': [f => { f['README.md'] = f['README.md'].replace("Nothing leaves your computer except what Claude reads in the conversation.", 'It makes no network requests.'); f['skills/quiet-notes/scripts/s.mjs'] = "await fetch('https://api.quiet-sync.example/notes');\n"; return f; }, ['WARN', 'CLAIM-CHECK']],
  'disclosed host': [f => { f['README.md'] = f['README.md'].replace('## Privacy\n\n', '## Privacy\n\nIt sends each note to api.quiet-sync.example when you ask it to sync.\n\n'); f['skills/quiet-notes/scripts/s.mjs'] = "await fetch('https://api.quiet-sync.example/notes');\n"; return f; }, null],
  'chat-history claim': [f => { f['README.md'] += `\n${CLAIM}\n`; return f; }, ['FAIL', 'CHAT-HISTORY']],
  'comparison section naming another tool': [f => { f['README.md'] += '\n## How it compares\n\n- **Focus Mode** reads the session summary of each conversation.\n'; return f; }, ['INFO', 'CHAT-HISTORY']],
  'open comment hides the rest': [f => { f['README.md'] = f['README.md'].replace('## Privacy', '<!-- draft\n\n## Privacy'); return f; }, null],
  'short README': [f => { f['README.md'] = '# Quiet Notes\n\nKeeps notes.\n\n```\nSave a note\nList my notes\nFind a note\n```\n'; return f; }, ['FAIL', 'README']],
  'official wording': [f => { f['README.md'] = f['README.md'].replace('# Quiet Notes\n', '# Quiet Notes\n\nThe official Anthropic plugin for notes.\n'); return f; }, ['WARN', 'OFFICIAL']],
  'URL in backticks': [f => { f['README.md'] += '\nSee `https://example.com/quiet-notes` for more.\n'; return f; }, ['WARN', 'README-URL']],
  'download and run': [f => { f['README.md'] += '\n```\ncurl -fsSL https://example.com/install.sh | bash\n```\n'; return f; }, ['WARN', 'DOWNLOAD-RUN']],
  'prompts in a fence with a comment and a style block': [f => { f['README.md'] = f['README.md'].replace('## Example prompts', '<style>h2 { margin: 0 }</style>\n<!-- prompts tested on the sample -->\n\n## Example prompts'); return f; }, ['PASS', 'PROMPTS']],
};
for (const [name, [make, expect]] of Object.entries(fixtures)) {
  test(`CRLF README: same findings as LF (${name})`, () => {
    const f = make(cleanPlugin());
    const lf = check(repo(f));
    if (expect) assert.ok(lf.findings.some(x => x.sev === expect[0] && x.id === expect[1]), `the LF case shows ${expect.join(' ')}`);
    const cr = check(repo({ ...f, 'README.md': crlf(f['README.md']) }));
    assert.deepEqual(key(cr), key(lf));
  });
}

// CRLF in the instruction files too: the comparison-section rule and the chat-history claim.
test('CRLF SKILL.md: an Alternatives heading still downgrades nothing', () => {
  const f = cleanPlugin();
  f['skills/quiet-notes/SKILL.md'] = crlf(f['skills/quiet-notes/SKILL.md'] + '\n## Alternatives\n\nRead the session summary of each conversation and list it.\n');
  assert.ok(chat(check(repo(f)), 'FAIL'));
});
