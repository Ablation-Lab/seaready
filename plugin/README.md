# Seaready

Seaready checks a Claude Code plugin before you submit it to Anthropic's plugin directory. It works in two parts:

- **A local script**, which makes no network requests. It runs many of the portal's blocking and hold rules, and checks for the Directory Policy problems a script can find, against your repository. Its name check covers only what it can see offline: the listings in Claude Code's local copy of the directory.
- **Claude, following the skill.** On every run it searches GitHub, the plugin directory and the web for plugins with the same or a similar name and for plugins that do similar things, then reads the code the script's findings point at to judge what a script can't. So the skill as a whole does use the network.

You get a report of what passes, what needs a look and what fails, suggested "How it compares" text for your README, and a drafted submission sheet with answers for every step of the portal form, for you to check and paste. Seaready never edits the repo it checks.

It grew out of submitting three plugins (Lore Lookup, Cutproof and SessionKeeper) and fixing what the portal held each time. Every problem we hit is now a check, tested on the commit from before the fix.

It adds one skill, `submission-check` (in Claude Code: `/seaready:submission-check`). It's an independent project, not made or endorsed by Anthropic, and a clean run is not approval: the portal's Validate, its security scan and Anthropic's reviewers decide.

## Install

In Claude Code 2.1.275 or later:

```
/plugin install seaready --marketplace Ablation-Lab/seaready
```

On older versions, add the marketplace first with `/plugin marketplace add Ablation-Lab/seaready`, then `/plugin install seaready@seaready`. To use the skill without the plugin, copy the `skills/submission-check` folder into `~/.claude/skills/`; it then runs as `/submission-check`. It needs Node.js 18 or later and git 2.44 or later.

## What it checks

| Area | What it looks for |
|---|---|
| Names (script, offline) | plugin and skill names against the portal's rules; "claude" or "anthropic" in skill names; clashes and look-alikes among the listings in Claude Code's local copy of the directory; listings there with similar descriptions (policy 2C) |
| Names and overlap (Claude, online, every run) | searches of GitHub (repos, other plugins' plugin.json and SKILL.md), the plugin directory's live listings and the web, including community skill directories, for the same or similar names and for plugins that do similar things. Results go in the report with suggested "How it compares" text for your README |
| Trigger wording | over-broad phrases in skill and command descriptions, such as "use whenever", "even if they haven't asked", "instead of using other tools" (policy 2A, 2C, 2D, 2E) |
| README versus code | programs started, files written outside the project, registry and shortcut changes, start-up entries, network hosts, deletes; each compared with the README's "what it runs, reads and writes" and Privacy sections, plus README claims such as "makes no network requests" that the code contradicts (policy 2B, 3C) |
| Chat history | code, or docs, pointing at Claude Code's conversation files, prompt history, memory files or conversation summaries, including in an app the plugin starts (policy 1G) |
| Reviewer material | at least three example prompts (3E), sample data and a section telling reviewers how to use it (3D), Privacy, Support, Troubleshooting sections |
| Hidden text | zero-width and bidirectional characters (in file contents and file names), tag characters (with the hidden text decoded), stray variation selectors, look-alike letters from other alphabets, encoded blobs and instruction-like HTML comments (policy 2G) |
| Line endings | `.gitattributes` rules, checked by comparing a real `git archive` (made with GitHub's settings) with the stored files byte for byte; a warning when your own `core.autocrlf` makes local copies differ |
| Scripts | shell-injection patterns (eval, `sh -c` with variables, variables in sed programs, Invoke-Expression, `exec` with built strings, `shell: true`), credential-like names, environment-variable reads, download URLs in messages, font and image names in code. Download-and-run commands (`curl … \| sh`, clone-and-install in one block) are checked in the README and in hook commands |
| Personal data | personal email addresses in files and in every commit's author, committer and content (only GitHub noreply addresses pass), local user paths, and your own private words if you keep a list |
| Listing fields | plugin.json name, version (and the same version in marketplace.json), description, author, licence, icon, documentation, support and privacy links; terms of service and classification (keywords, category, tags) flagged as optional |
| Portal limits | file names, system files, symlinks, submodules, LFS pointers, file sizes and counts (files and folders), binary files, hooks and MCP rules, and `claude plugin validate` |

Each finding says which policy section or portal rule it comes from, what the portal does about it (blocks, holds for a reviewer, warns), and how to fix it. It doesn't check everything the portal does: for example brand, publisher and fork look-alikes, minified code, and whether a plugin's scripts can be followed by the validator are left to the portal.

## Example prompts

```
Check this plugin repo before I submit it to the plugin directory
Run the submission check on the sample repo that samples/make-sample.mjs made, and explain each FAIL
Fill in the directory submission sheet for this plugin, with suggested data-handling answers
Will my .gitattributes stop the portal validating this repo?
```

Claude runs the checks, then reads the code the findings point at to judge the things a script can't (does the description match what the plugin does; is everything it writes and sends in the README; is the name used elsewhere), and finishes the sheet.

## Try it with the sample (for reviewers)

There's no account to set up: Seaready runs locally. The sample is a plugin repo with problems planted in it. A script makes it, and the script lives in the repository's `samples` folder, outside the plugin folder, so the planted problems never ship with the plugin. With Node.js 18 or later and git, from a clone of this repository:

```
node samples/make-sample.mjs
```

It prints the path of a new folder under your temp folder holding a two-commit git repo called Claude Helper. Then ask Claude:

```
Run the submission check on <the folder it printed>
```

The check ends with **NOT READY** and lists, among others: a reserved plugin name and a skill name containing "claude", an unquoted front matter value that stops it parsing, `.gitattributes` rewriting `install.cmd`, a script that greps Claude Code's conversation files, an undisclosed registry Run value and network request, hidden tag characters spelling "ignore the user", only two example prompts, and a personal email address in the first commit. [samples/expected-results.md](https://github.com/Ablation-Lab/seaready/blob/main/samples/expected-results.md) lists everything it should report.

**About the pattern files.** `skills/submission-check/scripts/lib/rules.mjs` and `lib/checks.mjs` contain the words and patterns Seaready looks for in other plugins: registry keys, credential-shaped names, "dangerously-skip-permissions", the paths of Claude Code's conversation files. They are pattern data and finding messages. Nothing in them runs a program, reads those locations, writes a file or makes a request; the only code that does anything outside the process is in `check.mjs` (writing the report, starting `claude plugin validate`) and `lib/git.mjs` (starting git). The repository's `.plugin-check-allow.json` records each self-match with its reason, and Seaready's own report shows them as ALLOWED.

**Developer note.** Seaready, our plugin submission checker, was built first and run on its own repository; the findings it raised there were fixed, and the matches that are its own pattern files are listed in `.plugin-check-allow.json` with reasons. It's our own pre-check; the directory's validation and Anthropic's reviewers make the actual decision. Seaready was also improved while it was checking itself. Its online name and overlap search was added after its offline name check missed an existing Claude Code plugin called tollgate, Seaready's first name. Its wording about what runs offline and what goes online, and its rule that it never edits the repo it checks, were tightened after problems with them were spotted during that work. Seaready was then used to check the four skills that followed (Tangent Jar, Bench Diary, Langparity and Council Dial; Bench Diary and Langparity were first called Lab Scribe and Driftcheck, and were renamed after its name search), including its online name and overlap search on each. On them it raised four false alarms: three patterns containing `~` that it read as home-folder paths (recorded with reasons in those repos' allow files and shown as allowed), and one description of a competing tool that it mistook for a claim about chat history (the description was reworded). Both kinds of false alarm were then fixed in Seaready itself, so those allow files were removed.

## What it runs, reads and writes

- **What it runs:**
  - `node <skill folder>/scripts/check.mjs <repo>`. Nothing is pre-approved, so Claude Code asks before it runs.
  - `git`, read-only. In your repository: `rev-parse`, `symbolic-ref`, `rev-list --count`, `config --get`, `remote get-url` and `ls-files`. Everything that reads file contents and history (`ls-tree`, `cat-file`, `archive`, `log`) runs in a temporary empty git folder that borrows your repo's objects and has no config of its own. Every git call also switches off the settings that can start a program: filters, signing programs, diff and pager programs, network protocols, and the lazy fetch a partial clone's remote could use. These are the ways we know of and test for; a git setting we haven't found could still exist, so check an untrusted repo from a fresh clone.
  - If the `claude` CLI is installed: `claude plugin validate` on a temporary copy of the plugin folder (skip it with `--no-validate`). It gets Seaready's environment minus Claude Code's session variables, and the claude CLI may contact Anthropic itself.
  - Programs run in an empty temporary folder, found through absolute PATH entries only. That folder and the temporary git folder are removed when the run ends. It never runs the checked plugin's own scripts.
  - On every run, Claude searches for name clashes and similar plugins: `gh search repos` and `gh search code` if the GitHub CLI is installed, and its own web search (GitHub, claude.com for the plugin directory, community skill directories). The queries are the plugin and skill names and a few words for what the plugin does.
- **What it reads:**
  - the repository you point it at: committed files and history through git, the working-tree files (to see what's uncommitted), your git config values for line endings, `.git/info/attributes`, and `.plugin-check-allow.json` if the repo has one;
  - `.privacy/patterns.txt` in that repo if there is one (skip it with `--no-repo-terms` for a repo that isn't yours: its author chose those patterns), or a list you pass with `--private-terms`;
  - two caches Claude Code keeps, read only, for the name check: `~/.claude/plugins/plugin-directory-cache-v2.json` (the directory's listings) and `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json` (marketplaces you've added). `--config-dir <folder>` points it at another Claude config folder.
- **What it writes:** `report.md`, `report.json` and `submission-sheet.md` in `<repo>/.plugin-check/`, which gets its own `.gitignore` so it's never committed (or in the folder you pass with `--out`). It refuses to write there if that folder is committed or is a link. In your temp folder it makes the empty git folder, an empty working folder and, for `claude plugin validate`, a copy of the plugin folder; the first and last are deleted when the run ends. The sample script writes one new folder under your temp folder (or one you name) and runs git inside it.
- **What it changes:** nothing else. Neither the script nor Claude edits, commits or pushes the repo it checks; suggested fixes and "How it compares" text go in the report for you to apply. It doesn't submit anything or change Claude Code's settings.
- **Network:** the script makes no requests; its name check uses Claude Code's local copy of the directory. The skill as a whole does use the network: on every run Claude searches GitHub, the plugin directory and the web, with the plugin and skill names and a short description of what the plugin does as the queries.

## Where it works

- **Claude Code** on Windows, macOS or Linux, with Node.js 18 or later and git 2.44 or later on the PATH. Older git is refused, because it lacks the option that stops a partial clone fetching objects (and so running a program its config names); macOS, Ubuntu 24.04 and Debian 12 ship older git, so install a newer one (for example from git-scm.com or Homebrew). It was built and tested on Windows 11 with Node 26 and Git for Windows.
- **Cowork:** the skill loads, but it needs a local git repository and Node, so it only works when the Cowork session runs on your computer.
- **Claude chat (claude.ai):** the skill loads but can't run, because it checks a git repository on your computer.

## Privacy

Seaready has no server, account or telemetry and collects nothing. Everything happens on your computer. It reads the repository you ask it to check, including commit authors' email addresses, and Claude Code's local copy of the directory listings, and writes its report and sheet next to your repository. Every finding and the JSON report are passed through one redaction step: email addresses other than GitHub noreply and example addresses are masked (`ab…@gmail.com`), and matches of your private terms are replaced with «private term N». Each pattern gets a time limit (1.5 s per batch of text): if one runs out of time, the check stops before writing anything and names the pattern, rather than risk printing text it should have hidden. What Claude reads from the report reaches Anthropic the way anything in your conversation does. On every run Claude searches GitHub and the web: the plugin and skill names, and a few words describing what the plugin does, are sent as search queries (to GitHub through the GitHub CLI, and to Claude's web search). Nothing else from your repo is sent.

## How it's built

- **JavaScript (Node.js ES modules).** `scripts/check.mjs` and the modules in `scripts/lib/` are plain JavaScript files that Node runs directly, with no packages to install. ES modules use `import`/`export` to share code between files. The checks are mostly regular expressions applied line by line, plus a few parsers.
- **git, alternates and the tar format.** `git archive` writes a commit's files as a tar file, the same way GitHub builds its downloads, applying the committed `.gitattributes`. Seaready runs it in a throwaway bare repository whose `objects/info/alternates` file points at your repo's objects, so it reads your commits without your repo's config. A tar file is a simple sequence of 512-byte headers and file contents; `lib/tar.mjs` reads it in memory. Comparing those bytes with the stored blobs (`git cat-file`) shows exactly which files an archive would change. Every git command is started with an argument list rather than a shell.
- **Markdown with YAML front matter.** A skill is a `SKILL.md` file: Markdown instructions for Claude, with a YAML block between `---` lines at the top holding its name and description. YAML is a "key: value" format with traps (an unquoted value starting with `[` or containing `: ` breaks it); `lib/frontmatter.mjs` is a strict reader that reports those traps rather than guessing.
- **JSON.** `plugin.json` (the plugin's manifest), `marketplace.json` (how Claude Code installs it from this repo) and `report.json` (the results, for Claude to read).
- **Unicode.** Text is decoded as UTF-8 and each character checked by its code point, so invisible characters can be named and located. The checker's source names every such character by its number, never as the character itself.
- **Safe output.** `lib/safety.mjs` renders anything quoted from the checked repo so it can't change the report: line breaks and invisible characters become visible codes, Markdown punctuation in names is escaped, and code lines go in code blocks fenced longer than anything inside them.

## Design decisions

- **Script plus judgement.** The script does what can be checked mechanically and leaves Claude a short list of things that need reading (does the description match the code; is every write in the README; is the name used outside the directory). Neither alone is enough.
- **Check what GitHub serves, not your folder.** The portal reads your pushed commit. The script reads committed files through `git archive` with GitHub's settings, so uncommitted edits and local line-ending conversion can't hide or invent problems. `--worktree` is there for checking before a commit.
- **Treat the checked repo as hostile.** It might be someone else's plugin you're vetting. The git settings known to start programs are switched off, its text can't add instructions to the report, its own allow file can't hide findings (see below), and its contents are redacted before anything is written.
- **Fail, warn or info, tied to the portal's own results.** FAIL means the portal blocks or stops, or a clear policy problem; WARN means likely held for a reviewer or worth fixing; INFO is for the sheet.
- **Offline script, required online search.** The script needs no network and sends nothing; its name check uses Claude Code's local copy of the directory, which can be out of date (the report shows its date) and doesn't include unlisted plugins. That gap is why Claude's search of GitHub, the plugin directory and the web is a required step on every run, not an option: this plugin's own first name, Tollgate, turned out to be taken by a plugin on GitHub that the directory copy didn't list.
- **Read-only, with suggestions.** Seaready never edits the repo it checks, even to add the "How it compares" text it drafts. You (or whoever is building the plugin) paste it in, so every change to your repo is yours.
- **No email addresses built in.** Rather than knowing your personal address, it fails every commit that isn't from a GitHub noreply address, and any personal webmail address in files or history.
- **Allowed exceptions are visible.** A committed `.plugin-check-allow.json` can mark a finding as allowed, but only with a reason, and allowed findings still appear in the report. An `EVIDENCE` entry marks a file as pattern data: its matches are shown as ALLOWED instead of counting as behaviour, never dropped. The report lists every entry in the allow file and says how many findings it allowed, because in a repo you don't trust, that file was written by its author.

## How it compares

- **The portal's Validate** is the authority, and runs after you push. Seaready runs before, on your machine, and adds the policy and disclosure checks that only Anthropic's reviewers and security scan apply later.
- **`claude plugin validate`** checks that files parse and match the schema, and runs a subset of the directory's checks. Seaready runs it for you and adds the rest above.
- **Directory Preflight** (in the directory) checks a plugin against the pre-submission checklist's rules. Seaready also covers the Directory Policy, README-versus-code disclosure, git history (emails, private words), line endings in a real archive, an online name and overlap search, and drafts the submission sheet.
- **protogrid** (in the directory) helps with MCP servers, including checking one before a directory submission. Seaready checks whole plugins (skills, commands, hooks, MCP) and their repository.
- **Community plugin validators** (validate-plugin, plugin-validator and claude-plugin-validation on skill sites) check a plugin's structure and plugin.json. Seaready checks those too, plus policy, disclosure, history and hidden text.
- **jadlis-plugin-builder** and **cc-third-party** (on GitHub) help build and release plugins, or vet third-party plugins before installing them. Seaready is a pre-submission check, and is also safe to run on a plugin you don't trust: it never runs its code and switches off the git settings known to run programs.

This list came from Seaready's own name and overlap search on 2026-11-05.

## The name

A ship is checked before it is cleared to sail; Seaready does the same for a plugin before it goes to the directory. It was called Tollgate during development, and renamed before release because another Claude Code plugin on GitHub already uses that name.

## Limits

**What it's for.** Seaready is for checking your own plugin before you submit it: it catches the honest mistakes that hold or block a submission. It is not a security scanner for code written to fool it. A plugin author who sets out to hide behaviour from a pattern-based check can do it.

**Checking a repo you don't trust.** Check it from a fresh clone (so the author's own `.git` folder and config never come with it), pass `--no-repo-terms` and `--out` with a folder in your temp folder, and read the code yourself. In our tests, nothing in a checked repo could run code, inject text into the report or leak your private data or email addresses; the known limits below are about misleading the checks and slowing them down.

**Known limits** (from nine independent rechecks on 2026-11-05, the last after the third round of fixes; the Ctrl+C regression that recheck found is fixed):
- It finds evidence with patterns, so it can miss things written in unusual ways and can flag harmless code. The judgement step catches some of both; the report says where to look. Known misses include:
  - denials it doesn't recognise as denials, such as "zilch", "refrains from" or unusual symbols;
  - text GitHub doesn't show but the check still reads, such as a link-reference title on its own line;
  - launchers with unusual options (`npm --loglevel silent exec`), inside commands over 8 KB, or named by a full Windows path (`C:\nodejs\npx.cmd`);
  - scripts reached indirectly (sourced by another script, or run after a `cd`);
  - home-folder writes far from where the path is set, or through tools like `rsync`, `dd` or `tar -C`.
- A repo built to be slow can still make the check slow: a private-term pattern from the repo's own list that is slow on many small files (each pattern has a 1.5 s limit per batch, and a pattern that runs out of time stops the run, but there is no limit on the total time); thousands of unclosed `<!--` in a README (the word count); one very long line of `](` without a `)`; and a very long run of spaces inside one front-matter line. Stop it with Ctrl+C and use the fresh-clone advice above. Many code fences and closed comments, and long blank runs in front-matter hooks, are read in linear time.
- A front-matter hook whose `command:` value follows a blank or comment line, or is a block scalar (`>` or `|`), isn't read, so a launcher there isn't flagged.
- A `~` counts as a home-folder path only where a path can start (after a space, a quote, `(` or `[`, `=`, `:` or `,`), so `~/x` written straight after a letter, digit, `)`, `]` or `}` isn't recognised, and a `~/` or `~\` inside a regular expression after `(`, `[` or a space (`[~/]`, `(?:~/)`, `/(~\d+)/`, `/[~\s]/`) still is. Code that builds a home path some other way (`os.homedir()`, `$HOME`, `%APPDATA%`) is still found.
- Chat-history words in the README's comparison section (under a heading such as How it compares, Alternatives, Similar tools, Related projects or See also) are a WARN, not a FAIL, because they may describe another tool; the script doesn't decide whose behaviour they describe, and the judgement step decides. Everywhere else, including SKILL.md, commands and agents under any heading, they keep their usual severity: a FAIL for conversation files, prompt history, memory and summaries, a WARN for the lighter words (the word "transcript", the live session registry and other session state). The WARN's detail lists only the first six sentences it found, so open the README at the line it names and go through the whole section. The section is found line by line and doesn't always match what GitHub shows:
  - it ends at the next heading of the same or a higher level, written with `#` (indented up to three spaces), as a setext heading (underlined with `===` or `---`) or as `<h1>` to `<h6>`, even when that heading is inside a code block or comment, so a section can end early (the words after it are then a FAIL);
  - a comparison heading inside a four-backtick fence that contains a three-backtick line, inside a fence whose closing line is indented four or more spaces, or after a second `<!--` on a line that already closed a comment, still starts a section (the words under it are then a WARN, not a FAIL);
  - a heading inside a blockquote (`> ## …`) or a list item (`- ## …`) doesn't end a section, and a comparison heading inside an HTML block such as `<pre>` still starts one (the words after it are then a WARN, not a FAIL);
  - headings written in bold or with emoji aren't recognised as comparison headings.
- The docs check for chat-history claims looks only at sentences with a verb it knows (reads, scans, parses, opens, loads, looks at, uses, lists, finds), so "collects" or "gathers" isn't caught. A denial word anywhere earlier in the same clause cancels it, including an unrelated one ("needs no setup and …"), which then counts as no claim at all.
- A `.plugin-check-allow.json` entry for CHAT-HISTORY can mark these findings ALLOWED, the comparison-section WARN included. The report's header counts ALLOWED findings; read each one.
- README text with Windows line endings (CRLF) is checked exactly like LF; a README with old Mac line endings (CR only) isn't, and its headings and example prompts are missed.
- When a home-folder pattern matches, the drafted data-handling answers say CHECK THE CODE inside the sentence; rewrite the sentence once you've checked.
- Very long lines made of word characters can make an ordinary private-term pattern run out of time, which stops the run. Simplify the pattern, or remove the long lines from what you check.
- A run removes its temporary folders (`seaready-cwd-…`, the empty folder programs run in, `seaready-mirror-…` and `seaready-validate-…`) when it finishes or fails. A run stopped with Ctrl+C, or killed (Task Manager, `taskkill`, closing the terminal window), stops at once without cleaning up and can leave them behind; they're safe to delete.
- The directory copy is only as fresh as Claude Code's cache. Open the plugin directory in Claude Code to refresh it.
- Rules change. The rules were read on 2026-11-05; `skills/submission-check/reference/policy.md` links the live pages.

## Troubleshooting

- **"is not a git repository"**: commit the plugin first; the portal reads from GitHub.
- **"plugin path … has no committed files"**: the folder name is wrong, or it isn't committed yet. Try `--worktree`.
- **"Couldn't check name clashes"**: open the plugin directory once in Claude Code (`/plugin`), then run again.
- **"CHECK-ERROR … stopped on unexpected input"**: a file has a field of the wrong type; the rest of the report still ran, and the detail says what failed.
- **"… is committed in this repo" or "… is a link"**: pass `--out` with another folder.
- **Every file is reported as changed by line endings**: check `.gitattributes`; the EOL-ARCHIVE finding lists the files.
- **`claude plugin validate` is slow or fails to start**: run with `--no-validate` and run it yourself.

## Support

Report problems at https://github.com/Ablation-Lab/seaready/issues. For a security concern, open an issue asking for a private contact rather than posting details.

## Licence

MIT. See the LICENSE file in the repository.

Research by Ablation Lab.
