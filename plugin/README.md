# Tollgate

Tollgate checks a Claude Code plugin before you submit it to Anthropic's plugin directory. It runs the portal's blocking rules and the Directory Policy against your repository, tells you what passes, what needs a look and what fails, and fills in a submission sheet with suggested answers for every step of the portal form.

It grew out of submitting three plugins (Lore Lookup, Cutproof and SessionKeeper) and fixing what the portal held each time. Every problem we hit is now a check, tested on the commit from before the fix.

It adds one skill, `submission-check` (in Claude Code: `/tollgate:submission-check`). It's an independent project, not made or endorsed by Anthropic, and a clean run is not approval: the portal's Validate, its security scan and Anthropic's reviewers decide.

## What it checks

| Area | What it looks for |
|---|---|
| Names | plugin and skill names against the portal's rules; "claude" or "anthropic" in skill names; clashes and look-alikes among the directory's existing listings; listings with similar descriptions (policy 2C) |
| Trigger wording | over-broad phrases in skill and command descriptions, such as "use whenever", "even if they haven't asked", "instead of using other tools" (policy 2A, 2C, 2D, 2E) |
| README versus code | programs started, files written outside the project, registry and shortcut changes, start-up entries, network hosts, deletes; each compared with what the README says, plus README claims such as "makes no network requests" that the code contradicts (policy 2B, 3C) |
| Chat history | code or docs that touch Claude Code transcripts, prompt history, memory files or conversation summaries, including an app the plugin starts (policy 1G) |
| Reviewer material | at least three example prompts (3E), sample data and a section telling reviewers how to use it (3D), Privacy, Support, Troubleshooting sections |
| Hidden text | zero-width and bidirectional characters, tag characters (with the hidden text decoded), stray variation selectors, look-alike letters from other alphabets, encoded blobs and instruction-like HTML comments (policy 2G) |
| Line endings | `.gitattributes` rules, checked by comparing a real `git archive` (made with GitHub's settings) with the stored files byte for byte; a warning when your own `core.autocrlf` makes local copies differ |
| Scripts | shell-injection patterns (eval, `sh -c` with variables, variables in sed programs, Invoke-Expression, `exec` with built strings, `shell: true`), credential-like names, environment-variable reads, download-and-run commands, font and image names in code |
| Personal data | personal email addresses in files and in every commit's author, committer and content (only GitHub noreply addresses pass), local user paths, and your own private words if you keep a list |
| Listing fields | plugin.json name, version (and the same version in marketplace.json), description, author, licence, icon, documentation, support and privacy links; terms of service and classification (keywords, category, tags) flagged as optional |
| Portal limits | file names, system files, symlinks, submodules, LFS pointers, file sizes and counts, binary files, hooks and MCP rules, and `claude plugin validate` |

Each finding says which policy section or portal rule it comes from, what the portal does about it (blocks, holds for a reviewer, warns), and how to fix it.

## Example prompts

```
Check this plugin repo before I submit it to the plugin directory
Run the submission check on C:\Projects\my-plugin and explain each FAIL
Fill in the directory submission sheet for this plugin, with suggested data-handling answers
Will my .gitattributes stop the portal validating this repo?
```

Claude runs the checks, then reads the code the findings point at to judge the things a script can't (does the description match what the plugin does; is everything it writes and sends in the README), and finishes the sheet.

## Try it with the sample (for reviewers)

There's no account to set up: Tollgate runs locally. The sample is a plugin repo with problems planted in it. A script makes it, and the script lives in the repository's `samples` folder, outside the plugin folder, so the planted problems never ship with the plugin. With Node.js 18 or later and git, from a clone of this repository:

```
node samples/make-sample.mjs
```

It prints the path of a new folder under your temp folder holding a two-commit git repo called Claude Helper. Then ask Claude:

```
Run the submission check on <the folder it printed>
```

The check ends with **NOT READY** and lists, among others: a reserved plugin name and a skill name containing "claude", an unquoted front matter value that stops it parsing, `.gitattributes` rewriting `install.cmd`, a script that greps Claude Code transcripts, an undisclosed registry Run value and network request, hidden tag characters spelling "ignore the user", only two example prompts, and a personal email address in the first commit. [samples/expected-results.md](https://github.com/Ablation-Lab/tollgate/blob/main/samples/expected-results.md) lists everything it should report.

## What it runs, reads and writes

- **What it runs:** `node <skill folder>/scripts/check.mjs <repo>`. Nothing is pre-approved, so Claude Code asks before it runs. The script starts `git` (read-only commands: rev-parse, ls-tree, cat-file, archive, log, diff, ls-files, config, remote) and, if the `claude` CLI is installed, `claude plugin validate` on a temporary copy of the plugin folder (skip it with `--no-validate`). It never runs the checked plugin's own scripts.
- **What it reads:** the repository you point it at, through git (committed files, history, and your git config for line endings); `.privacy/patterns.txt` in that repo if there is one, or a list you pass with `--private-terms`; and two caches Claude Code keeps, read only, for the name check: `~/.claude/plugins/plugin-directory-cache-v2.json` (the directory's listings) and `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json` (marketplaces you've added).
- **What it writes:** `report.md`, `report.json` and `submission-sheet.md` in `<repo>/.plugin-check/`, which gets its own `.gitignore` so it's never committed (or in the folder you pass with `--out`). For `claude plugin validate` it writes a copy of the plugin folder in your temp folder and deletes it straight after. The sample script writes one new folder under your temp folder (or one you name) and runs git inside it.
- **What it changes:** nothing else. It doesn't edit, commit or push your repo, doesn't submit anything, and doesn't change Claude Code's settings.
- **Network:** none. It makes no requests; the name check uses Claude Code's local copy of the directory.

## Where it works

- **Claude Code** on Windows, macOS or Linux, with Node.js 18 or later and git on the PATH. It was built and tested on Windows 11 with Node 26 and Git for Windows.
- **Cowork:** the skill loads, but it needs a local git repository and Node, so it only works when the Cowork session runs on your computer.
- **Claude chat (claude.ai):** the skill loads but can't run, because it checks a git repository on your computer.

## Privacy

Tollgate has no server, account or telemetry and collects nothing. Everything happens on your computer. It reads the repository you ask it to check and Claude Code's local copy of the directory listings, and writes its report and sheet next to your repository. The report masks email addresses and never prints the words in your private list. What Claude reads from the report reaches Anthropic the way anything in your conversation does.

## How it's built

- **JavaScript (Node.js ES modules).** `scripts/check.mjs` and the modules in `scripts/lib/` are plain JavaScript files that Node runs directly, with no packages to install. ES modules use `import`/`export` to share code between files. The checks are mostly regular expressions applied line by line, plus a few parsers.
- **git and the tar format.** `git archive` writes a commit's files as a tar file, the same way GitHub builds its downloads, applying the rules in `.gitattributes`. A tar file is a simple sequence of 512-byte headers and file contents; `lib/tar.mjs` reads it in memory. Comparing those bytes with the stored blobs (`git cat-file`) shows exactly which files an archive would change. Every git command is started with an argument list rather than a shell, and with settings that stop a repo's config from running programs.
- **Markdown with YAML front matter.** A skill is a `SKILL.md` file: Markdown instructions for Claude, with a YAML block between `---` lines at the top holding its name and description. YAML is a "key: value" format with traps (an unquoted value starting with `[` or containing `: ` breaks it); `lib/frontmatter.mjs` is a strict reader that reports those traps rather than guessing.
- **JSON.** `plugin.json` (the plugin's manifest), `marketplace.json` (how Claude Code installs it from this repo) and `report.json` (the results, for Claude to read).
- **Unicode.** Text is decoded as UTF-8 and each character checked by its code point, so invisible characters can be named and located. The checker writes every character it looks for as a `\u` escape.

## Design decisions

- **Script plus judgement.** The script does what can be checked mechanically and leaves Claude a short list of things that need reading (does the description match the code; is every write in the README). Neither alone is enough.
- **Check what GitHub serves, not your folder.** The portal reads your pushed commit. The script reads committed files through `git archive` with GitHub's settings, so uncommitted edits and local line-ending conversion can't hide or invent problems. `--worktree` is there for checking before a commit.
- **Fail, warn or info, tied to the portal's own results.** FAIL means the portal blocks or stops, or a clear policy problem; WARN means likely held for a reviewer or worth fixing; INFO is for the sheet.
- **Offline.** Name clashes come from Claude Code's local copy of the directory, so the check needs no network and sends nothing. The copy can be out of date; the report shows its date.
- **No email addresses built in.** Rather than knowing your personal address, it fails every commit that isn't from a GitHub noreply address, and any personal webmail address in files or history.
- **Allowed exceptions are visible.** A committed `.plugin-check-allow.json` can mark a finding as allowed, but only with a reason, and allowed findings still appear in the report. This repository uses it for its own rule tables, which contain the patterns they look for.

## How it compares

- **The portal's Validate** is the authority, and runs after you push. Tollgate runs before, on your machine, and adds the policy and disclosure checks that only Anthropic's reviewers and security scan apply later.
- **`claude plugin validate`** checks that files parse and match the schema. Tollgate runs it for you and goes much further.
- **Directory Preflight** (an existing directory listing) checks a plugin against the pre-submission checklist's rules. Tollgate also covers the Directory Policy, README-versus-code disclosure, git history (emails, private words), line endings in a real archive, and writes the submission sheet.

## Limits

- It finds evidence with patterns, so it can miss things written in unusual ways and can flag harmless code. The judgement step catches some of both; the report says where to look.
- The directory copy is only as fresh as Claude Code's cache. Open the plugin directory in Claude Code to refresh it.
- Rules change. The rules were read on 2026-11-05; `skills/submission-check/reference/policy.md` links the live pages.

## Troubleshooting

- **"is not a git repository"**: commit the plugin first; the portal reads from GitHub.
- **"plugin path … has no committed files"**: the folder name is wrong, or it isn't committed yet. Try `--worktree`.
- **"Couldn't check name clashes"**: open the plugin directory once in Claude Code (`/plugin`), then run again.
- **Every file is reported as changed by line endings**: check `.gitattributes`; the EOL-ARCHIVE finding lists the files.
- **`claude plugin validate` is slow or fails to start**: run with `--no-validate` and run it yourself.

## Support

Report problems at https://github.com/Ablation-Lab/tollgate/issues. For a security concern, open an issue asking for a private contact rather than posting details.

## Licence

MIT. See the LICENSE file in the repository.

Research by Ablation Lab.
