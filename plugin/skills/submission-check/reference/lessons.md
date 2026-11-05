# What earlier submissions ran into

Three Ablation Lab plugins went through the directory portal in November 2026: Lore Lookup, Cutproof and SessionKeeper (all public on GitHub under Ablation-Lab). These are the problems the portal or our own review found, the fix that cleared each, and the check that now catches it. Every check below was tested by running it on the commit from before the fix.

| Problem | Plugin | Portal result | Fix that cleared it | Check |
|---|---|---|---|---|
| Skill named `claude-lore` | Lore Lookup | claude.ai and API uploads refuse "claude" in skill names | renamed to `lore-lookup` | SKILL-NAME |
| Literal invisible characters in a sanitiser's source | Lore Lookup | hidden-character risk (2G) | wrote them as `\u` escapes | UNICODE-HIDDEN |
| "Use whenever …" and "whether Claude can do something" in the description | Lore Lookup | over-broad trigger (2A, 2D) | "Use when …" and "whether a Claude product has a feature" | TRIGGER |
| No supportUrl or privacyPolicyUrl | Lore Lookup | Warnings | added both, pointing at README sections | MANIFEST-URLS |
| A lock file's random ID named `LOCK_TOKEN` | Lore Lookup | Held: "Uses a credential from the user's machine" | renamed to `lockId` | CREDENTIAL-NAME |
| Identifiers that looked like credentials: `TokA`/`TokB`, `$key`, `$envCache` | Cutproof | same hold | renamed | CREDENTIAL-NAME |
| A test opened the bundled icon; the icon's file name in a README code block | Lore Lookup | Held: "Image or font file the plugin's code could run" | removed the test and the name | CODE-ASSET, ASSET-REF |
| The sample script named a font file (`arialbd.ttf`) | Cutproof | same hold | drew text in a system font by family name | CODE-ASSET |
| `git clone … ` and the installer in one code block | Lore Lookup | Held: "Contains a download-and-run command" | split into clone, then run | DOWNLOAD-RUN |
| The ffmpeg-missing message pointed at a download URL | Cutproof | part of clearing the holds | pointed at the README instead | DOWNLOAD-URL |
| Folders found through `$env:` variables | Cutproof | part of clearing the holds | `[Environment]::GetFolderPath` | ENV-PATH |
| `SESSIONKEEPER_EXE` environment override | SessionKeeper | part of clearing the holds | removed; fixed install folder or PATH | ENV-OTHER |
| `allowed-tools` pre-approvals | Cutproof, SessionKeeper | part of clearing the holds | removed; Claude Code asks before each command, and the README says so | SKILL-PREAPPROVE |
| A line number passed into a `sed` program unchecked (GNU sed's `e` command can run code) | privacy check script in all three | our own review | validate it's a positive whole number first | INJECTION |
| `$'…'` ANSI-C quoting | privacy check script | our own review | `printf -v` | ANSI-C (info) |
| Documentation link auto-filled from a backticked URL, closing backtick included | Lore Lookup | wrong listing link | `documentationUrl` in plugin.json; Markdown links | README-URL, MANIFEST-URLS |
| `*.cmd text eol=crlf` in `.gitattributes` | SessionKeeper | Validation stops ("Couldn't validate that repository"): archives rewrote install.cmd | stored install.cmd with CRLF and marked it `-text` | EOL-ARCHIVE, GITATTR-TEXT |
| No sample data | Cutproof | policy 3D | a script that makes a 6-second sample video, plus expected results | SAMPLE |
| plugin.json and marketplace.json versions drifting | Cutproof | our own rule | kept equal | VERSION-MATCH |
| A front matter value starting with `[` unquoted: the whole front matter silently failed to parse | SessionKeeper | our own testing | quoted it | FRONTMATTER |
| Commands with `disable-model-invocation` were invisible to Claude, so it said they didn't exist | SessionKeeper | our own testing | every command and the skill list all commands | SKILL-INVOCATION (info) |
| Reads Claude Code transcripts (`~/.claude/projects`) for session titles | SessionKeeper | open policy 1G question, explained in "For reviewers" | not fixed; it's the app's core function | CHAT-HISTORY |
| Video binary would be held | Cutproof | binaries other than images are held | sample made by a script instead of committed | FILE-BINARY |

## Things that were fine

- `* text=auto eol=lf` in `.gitattributes` validated, because it changes no committed file in a Linux archive. The check now compares a real archive with the stored files instead of guessing from the rule.
- Secret-detection patterns in a maintainer's pre-commit script (`ghp_`, `password`) raised a question once; labelling the script in the README as a maintainer tool the plugin never runs was the answer prepared for reviewers. Keeping such tools outside the plugin folder avoids the question.

## Local traps

- With `core.autocrlf=true` (Git for Windows' default), the working tree has CRLF line endings that GitHub's copy doesn't. Greps, hashes and zips made from the working tree don't match what the portal reads. The checker reads committed blobs and a GitHub-like archive instead, and warns when your config differs.
