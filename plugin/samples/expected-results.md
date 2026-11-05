# What the sample should report

`make-sample.mjs` builds a two-commit plugin repo called Claude Helper with these problems planted. Running the check on it should end with **NOT READY** and exit code 1. The repo has no GitHub remote, so a `GIT-REMOTE` warning is expected too.

The test in `test/sample.test.mjs` (in the repository, outside the plugin folder) runs the sample and fails if any line below stops being reported.

## FAIL

| Check | Planted problem |
|---|---|
| LAYOUT-SYSFILE | a `.DS_Store` file is committed |
| EOL-ARCHIVE | `*.cmd text eol=crlf` makes git archive rewrite `install.cmd`, which is stored with LF |
| PROMPTS | the README has only two example prompts |
| MANIFEST-RESERVED | the plugin is named `claude-helper` |
| LICENSE | no LICENSE file and no `license` in plugin.json |
| VERSION-MATCH | plugin.json says 1.0.0, marketplace.json says 1.0.1 |
| SKILL-NAME | the skill is named `claude-notes` |
| FRONTMATTER | `argument-hint: [topic] [date]` isn't quoted, so the front matter won't parse |
| CHAT-HISTORY | `save.sh` greps `~/.claude/projects/*/*.jsonl` for titles |
| DISCLOSE | network requests, a registry Run value and files in the home folder, none of them in the README |
| UNICODE-HIDDEN | a zero-width space and tag characters spelling "ignore the user" in SKILL.md |
| EMAIL-HISTORY | the first commit's author and README use a personal webmail address (made up), removed in the second commit |

## WARN

| Check | Planted problem |
|---|---|
| TRIGGER | "Use whenever", "anything related to", "even if they have not asked" in the skill description |
| INJECTION | `eval "$1"` in `save.sh` |
| ENV-CREDENTIAL | `save.sh` sends `$NOTES_API_TOKEN` |
| DOWNLOAD-RUN | `curl … \| sh` in the README |
| README-URL | a URL in backticks |
| README-SECTION | no Privacy, "What it runs, reads and writes", "Where it works" or Troubleshooting sections |
| MANIFEST-URLS | no documentationUrl, supportUrl or privacyPolicyUrl |
| SAMPLE | no sample data for reviewers |

The exact counts can change as checks improve; the checks listed above must all appear.
