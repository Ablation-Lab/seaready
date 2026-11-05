import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../plugin/skills/submission-check/scripts/lib/frontmatter.mjs';
import { scanUnicode, mixedScriptWords, decodeTagRun } from '../plugin/skills/submission-check/scripts/lib/unicode.mjs';
import * as R from '../plugin/skills/submission-check/scripts/lib/rules.mjs';
import { examplePrompts, githubSlug, stripCode } from '../plugin/skills/submission-check/scripts/lib/checks.mjs';
import { consolidate, parseArgs } from '../plugin/skills/submission-check/scripts/check.mjs';
import { findClashes, norm } from '../plugin/skills/submission-check/scripts/lib/directory.mjs';

const fm = body => parseFrontmatter(`---\n${body}\n---\nbody\n`);

test('front matter: plain values parse', () => {
  const r = fm('name: my-skill\ndescription: Does a thing. Use when asked.\nlicense: MIT');
  assert.equal(r.errors.length, 0);
  assert.equal(r.data.name, 'my-skill');
  assert.equal(r.data.description, 'Does a thing. Use when asked.');
});

test('front matter: SessionKeeper trap, unquoted [ that is not one complete list', () => {
  assert.ok(fm('argument-hint: [days] [all]').errors.length, '[days] [all] must be an error');
  assert.equal(fm('argument-hint: [topic]').errors.length, 0, 'a single complete list is valid YAML');
  assert.equal(fm('argument-hint: "[days] [all]"').errors.length, 0, 'quoted is fine');
});

test('front matter: ": " in a plain value and reserved first characters are errors', () => {
  assert.ok(fm('description: Use when: the user asks').errors.length);
  assert.ok(fm('description: @mention me').errors.length);
  assert.ok(fm('description: `code` first').errors.length);
  assert.equal(fm('description: "Use when: the user asks"').errors.length, 0);
});

test('front matter: " #" is noted, block scalars and lists work', () => {
  assert.ok(fm('description: Use it #1 way').notes.length);
  const r = fm('description: >\n  Folded line one\n  and two\nallowed-tools:\n  - Read\n  - Grep');
  assert.equal(r.errors.length, 0);
  assert.equal(r.data.description, 'Folded line one and two');
  assert.deepEqual(r.data['allowed-tools'], ['Read', 'Grep']);
});

test('unicode: hidden characters are found, emoji sequences are not', () => {
  const zw = String.fromCodePoint(0x200B), rlo = String.fromCodePoint(0x202E), vs16 = String.fromCodePoint(0xFE0F), zwj = String.fromCodePoint(0x200D);
  const hits = scanUnicode(`a${zw}b ${rlo}c`);
  assert.deepEqual(hits.map(h => h.code), ['U+200B', 'U+202E']);
  assert.equal(scanUnicode(`ok ${String.fromCodePoint(0x2764)}${vs16} ${String.fromCodePoint(0x1F469)}${zwj}${String.fromCodePoint(0x1F4BB)}`).length, 0);
  assert.equal(scanUnicode(`x${vs16}`)[0].kind, 'hidden', 'a variation selector after a letter is hidden');
});

test('unicode: tag characters decode, look-alike letters are found', () => {
  const tags = [...'hi'].map(c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join('');
  assert.equal(decodeTagRun(`x${tags}`), 'hi');
  assert.equal(mixedScriptWords(`p${String.fromCodePoint(0x0430)}ypal`).length, 1, 'Cyrillic a in a Latin word');
  assert.equal(mixedScriptWords('plain English words').length, 0);
});

test('rules: false positives fixed during testing stay fixed', () => {
  const browser = R.SIDE_EFFECTS.find(s => s.id === 'clipboard-browser');
  assert.ok(!browser.code.test('function clip(text, max) {'), 'a function called clip');
  assert.ok(!browser.code.test("if ($h -match '^(file|clip|audio)')"), 'clip inside an alternation');
  assert.ok(browser.code.test('$text | clip'), 'piping to clip');
  assert.ok(!R.LOCAL_USER_PATH.test('C:\\Users\\YOUR-NAME\\AppData'), 'placeholder user name');
  assert.ok(!R.LOCAL_USER_PATH.test('C:\\Users\\<you>\\x'), 'angle-bracket placeholder');
  assert.ok(R.LOCAL_USER_PATH.test('C:\\Users\\jsmith\\AppData'), 'a real-looking user name');
  assert.ok(R.SAFE_EMAIL.test('test@example.invalid'));
  const trig = R.TRIGGER_PHRASES.map(([re]) => re);
  assert.ok(!trig.some(re => re.test('citing them, instead of answering from memory')), 'Lore Lookup wording is fine');
  assert.ok(trig.some(re => re.test('instead of reviewing it yourself')));
  assert.ok(trig.some(re => re.test('Use whenever the user mentions notes')));
});

test('README helpers: prompts, slugs, code stripping keeps line numbers', () => {
  const md = '# T\n\n## Example prompts\n\n```\nFirst prompt here\nSecond prompt here\n```\n\n- Third prompt is a bullet\n\n## Next\n';
  assert.equal(examplePrompts(md).prompts.length, 3);
  assert.equal(githubSlug('What it runs, reads and writes'), 'what-it-runs-reads-and-writes');
  const s = stripCode('a\n```\nx\n```\nb');
  assert.equal(s.split('\n').length, 5);
  assert.equal(s.length, 'a\n```\nx\n```\nb'.length);
});

test('consolidate merges repeats and lists lines', () => {
  const out = consolidate([{ sev: 'WARN', id: 'X', title: 't', file: 'f', line: 1 }, { sev: 'WARN', id: 'X', title: 't', file: 'f', line: 9 }]);
  assert.equal(out.length, 1);
  assert.match(out[0].detail, /Lines: 1, 9/);
});

test('parseArgs refuses a ref with shell characters', () => {
  const exit = process.exit;
  let code = null;
  process.exit = c => { code = c; throw new Error('exit'); };
  const err = console.error; console.error = () => {};
  try { assert.throws(() => parseArgs(['repo', '--ref', 'HEAD;rm -rf /'])); } finally { process.exit = exit; console.error = err; }
  assert.equal(code, 2);
  assert.equal(parseArgs(['repo', '--ref', 'v1.0.0']).ref, 'v1.0.0');
});

test('name clashes: same name, look-alike, own repo', () => {
  const listings = { items: [
    { name: 'quiet-notes', displayName: 'Quiet Notes', repo: 'github.com/someone/quiet-notes#' },
    { name: 'quiet-note', displayName: 'Quiet Note', repo: 'github.com/other/qn#' },
    { name: 'my-tool', displayName: 'My Tool', repo: 'github.com/me/my-tool#' },
  ], sources: [] };
  assert.equal(findClashes(listings, { name: 'Quiet_Notes' }, null).exact.length, 1, 'case and punctuation count as the same');
  assert.ok(findClashes(listings, { name: 'quiet-notez' }, null).similar.length >= 1);
  const own = findClashes(listings, { name: 'my-tool' }, 'github.com/me/my-tool');
  assert.equal(own.exact.length, 0);
  assert.ok(own.similar.some(s => s.own));
  assert.equal(norm('Cut-Proof'), 'cutproof');
});
