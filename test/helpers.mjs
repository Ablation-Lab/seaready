// Test helpers: throwaway git repos in the temp folder, with a fixed noreply identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const NOREPLY = '1000002+test-dev@users.noreply.github.com';

export function tmpDir(prefix = 'seaready-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root, rel, content) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export function git(root, args, email = NOREPLY, input) {
  return execFileSync('git', ['-C', root, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=.no-hooks',
    '-c', 'user.name=Test Dev', '-c', `user.email=${email}`, ...args], { encoding: 'utf8', stdio: 'pipe', input });
}

export function repo(files, { email } = {}) {
  const root = tmpDir();
  git(root, ['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'test'], email);
  return root;
}

// An empty Claude config dir, or one holding a small fake directory cache.
export function configDir(listings = []) {
  const dir = tmpDir('seaready-cfg-');
  if (listings.length) {
    const cache = { schemaVersion: 2, fetchedAt: '2026-11-01T00:00:00.000Z', listings: [], entryNames: {}, entryNameClaims: {} };
    listings.forEach((l, i) => {
      const id = `plugin_test${i}`;
      cache.listings.push({ id, name: l.displayName || l.name, summary: l.summary || '' });
      cache.entryNames[id] = l.name;
      cache.entryNameClaims[id] = { repositoryKey: l.repo || `github.com/someone/${l.name}#` };
    });
    write(dir, 'plugins/plugin-directory-cache-v2.json', JSON.stringify(cache));
  }
  return dir;
}

// A minimal plugin that should pass with no FAIL.
export function cleanPlugin(name = 'quiet-notes') {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name, displayName: 'Quiet Notes', version: '1.0.0', description: 'Keeps short notes in a notes folder in your project.',
      author: { name: 'Test Dev' }, license: 'MIT', documentationUrl: 'https://github.com/test-dev/quiet-notes/blob/main/README.md',
      supportUrl: 'https://github.com/test-dev/quiet-notes/issues', privacyPolicyUrl: 'https://github.com/test-dev/quiet-notes#privacy',
    }, null, 2),
    'skills/quiet-notes/SKILL.md': '---\nname: quiet-notes\ndescription: Keeps short notes in the notes folder of the current project. Use when the user asks to save, list or find a note.\nlicense: MIT\n---\n\n# Quiet notes\n\nWrite each note as a Markdown file in the notes folder.\n',
    'samples/notes/example-note.md': '# Example note\n\nA sample note for reviewers.\n',
    'README.md': [
      '# Quiet Notes', '',
      'Quiet Notes keeps short notes as Markdown files in a notes folder inside your project, and finds them again when you ask. It is a single skill with no scripts, so it only reads and writes files in that folder.', '',
      '## Example prompts', '', '```', 'Save a note that the build needs Node 20', 'List my notes from this week', 'Find the note about the build', '```', '',
      '## Try it with the sample', '', 'Open the samples folder as a project and ask Claude to list the notes.', '',
      '## What it reads and writes', '', 'Only Markdown files in the notes folder of the current project.', '',
      '## Where it works', '', 'Claude Code, Cowork and chat.', '',
      '## Privacy', '', 'Nothing leaves your computer except what Claude reads in the conversation.', '',
      '## Troubleshooting', '', 'If no notes are found, check the notes folder exists.', '',
      '## Support', '', 'Open an issue on GitHub.', '',
    ].join('\n'),
  };
}

export const ids = (findings, sevs = ['FAIL', 'WARN']) => new Set(findings.filter(f => sevs.includes(f.sev)).map(f => f.id));
