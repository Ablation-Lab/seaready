# Rules the checks are based on

Fetched on 2026-11-05. Rules change; when a finding disagrees with the live pages, the live pages win.

- Anthropic Software Directory Policy: https://support.claude.com/en/articles/13145358
- Plugin pre-submission checklist: https://claude.com/docs/plugins/pre-submission-checklist
- Submit your plugin: https://claude.com/docs/plugins/submit
- Plugin manifest reference: https://code.claude.com/docs/en/plugins-reference

## Directory Policy sections the checks cite

Short summaries; read the policy for the exact wording.

| Section | What it asks | Checks |
|---|---|---|
| 1E | Collect only the data needed; no extraneous conversation data, "even for logging purposes". | judgement |
| 1G | Don't query or extract data from Claude's memory, chat history, conversation summaries or user-generated or uploaded files; don't build profiles from conversation content or change Claude's behaviour across sessions. | CHAT-HISTORY, COMPANION-1G |
| 2A | Describe each tool or capability in narrow, unambiguous language: what it does and when to invoke it. | SKILL-DESC, TRIGGER |
| 2B | Descriptions must precisely match actual functionality; no unexpected functionality, no undelivered features. | DISCLOSE, CLAIM-CHECK, judgement |
| 2C | Descriptions must not create confusion or conflict with other directory software. | NAME-CLASH, NAME-SIMILAR, OVERLAP |
| 2D | Don't coerce Claude into calling other tools unless the user wants it; descriptions must not be written to make other software call them extraneously. | TRIGGER |
| 2E | Don't interfere with Claude calling other tools. | TRIGGER, OTHER-TOOLS |
| 2F | Don't direct Claude to pull behavioural instructions from external sources at runtime. | REMOTE-INSTRUCTIONS |
| 2G | No hidden, obfuscated or encoded instructions; all guidance human-readable. | UNICODE-HIDDEN, UNICODE-HOMOGLYPH, ENCODED, HIDDEN-COMMENT |
| 3A | A clear privacy policy link for software that collects data or connects to a remote service. | MANIFEST-URLS (privacyPolicyUrl), README-SECTION Privacy |
| 3B | Verified contact information and support channels. | MANIFEST-URLS (supportUrl), README-SECTION Support |
| 3C | Document how it works, its purpose and how to troubleshoot. | README-SECTION |
| 3D | A standard testing account with sample data so Anthropic can verify full functionality. | SAMPLE |
| 3E | At least three working example prompts or use cases. | PROMPTS |
| 3F | Own or control the endpoints and domains it connects to (plugins may use approved connectors). | DISCLOSE-HOST, judgement |
| 4A–4E | Unsupported: autonomous money movement and crypto, AI image/video/audio generation (design visuals excepted), ads, adult content, safeguard evasion. | POLICY-4 (a prompt to check, never a verdict) |

## Portal checklist rules the checks mirror

Results the portal gives: **Blocks** (can't submit), **Held for a reviewer** (policy hold), **Warning**, **Note**, and **Validation stops** (no report, "Couldn't validate that repository").

- Folder layout: submit the folder with `.claude-plugin/plugin.json`; everything the plugin runs inside it; no symlinks, submodules or LFS pointers where the plugin loads them; no `.DS_Store`, `Thumbs.db`, `desktop.ini`, `__MACOSX` (Blocks).
- File names valid on Windows and macOS; plugin-path folders use letters, digits, dots, hyphens, underscores (Validation stops).
- `.gitattributes`: no `export-ignore`/`export-subst` anywhere; no `filter` (LFS included) or other content-rewriting attributes at or above the plugin folder (Validation stops).
- Size: archive under 50 MiB, under 256 MiB unpacked, under 10,000 files; plugin files under 5 MiB (Validation stops). Non-image, non-font files over 256 KiB, more than 512 files, or other binaries such as `.ico`, `.pdf`, `.zip` (Held).
- Name: lowercase letters, digits, hyphens, up to 64; non-ASCII blocks; reserved names (`claude`, `anthropic`, `official`, `plugin`, `mcp`, `test` as the whole name, names that pass as Anthropic's) block; names taken by another organization block; look-alikes and generic-only names are held.
- `displayName` and `author.name`: one writing system, no look-alike or invisible characters (Blocks).
- README of at least 40 words outside code blocks in the plugin folder; a licence (LICENSE file or `license`) (Blocks).
- Images and fonts: show bundled images with Markdown image syntax; don't name bundled images or fonts from commands, hooks or scripts, or in backticks or code blocks (Held).
- Launchers (`npx`, `uvx`, …) pinned to exact versions (unpinned Blocks; pinned is Held); no package-manager config that sets a registry; lockfile installs Held.
- No real credentials anywhere (Blocks); reading a credential from the user's environment is Held.
- `.mcp.json`, `hooks/hooks.json` valid; remote MCP URLs https; local MCP servers started by running a file, not a shell or inline program.
- Front matter must parse; `description` must be text (Blocks).
- The security scan rejects undisclosed behaviour ("Sends data to an undisclosed destination") and code it can't read. Describe in the README everything the plugin runs, sends or fetches.

## plugin.json listing fields

`icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` are read by the directory (Claude Code ignores them). Each URL must be `https://`. `termsOfServiceUrl` is optional. Classification is optional too: `keywords` in plugin.json, and `category` and `tags` on the marketplace entry.

## Skill front matter for claude.ai uploads

claude.ai skill uploads and the Skills API accept only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Skill names can't contain "claude" or "anthropic". Agent Skills limits: name up to 64 characters matching the folder; description up to 1,024 characters; compatibility up to 500. Claude Code truncates description plus `when_to_use` at 1,536 characters in its skill listing.
