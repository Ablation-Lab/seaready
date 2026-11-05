// Detection patterns used by the checks. This file is data: it only describes what to look
// for in the plugin under test. Nothing here reads credentials, the registry or the network;
// the words appear because those are the things the checker searches other plugins for.

export const CODE_EXT = /\.(m?js|cjs|ts|mts|cts|jsx|tsx|py|ps1|psm1|psd1|sh|bash|zsh|cmd|bat|cs|go|rb|rs|java|kt|php|pl|lua|swift)$/i;
export const SHELL_EXT = /\.(sh|bash|zsh)$/i;
export const PS_EXT = /\.(ps1|psm1|psd1)$/i;
export const BATCH_EXT = /\.(cmd|bat)$/i;
export const JS_EXT = /\.(m?js|cjs|ts|mts|cts|jsx|tsx)$/i;
export const PY_EXT = /\.py$/i;
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
export const FONT_EXT = /\.(ttf|otf|woff2?|eot)$/i;
export const BINARY_EXT = /\.(ico|pdf|zip|7z|gz|tgz|tar|rar|exe|dll|so|dylib|bin|msi|mcpb|dxt|jar|class|pyc|wasm|mp4|mov|mkv|avi|webm|mp3|wav|flac|ogg|m4a|docx?|xlsx?|pptx?|psd|sqlite|db)$/i;

// Words in skill and command descriptions that widen when Claude calls them (policy 2A, 2C, 2D).
// Each entry: [regex, why].
export const TRIGGER_PHRASES = [
  [/\buse (this skill )?whenever\b/i, '"use whenever" invites calls for anything loosely related'],
  [/\bwhenever (the user|someone|you)\b/i, '"whenever the user…" is open-ended'],
  [/\b(always|must) (use|invoke|call|run|load) (this|me|it)\b/i, 'tells Claude it must always call this skill'],
  [/\b(any|every|all) (time|request|task|question|message|conversation|prompt)s?\b/i, 'claims every request or task'],
  [/\beven if (they|the user|you|someone) (have|has|haven't|hasn't|did not|didn't|do not|don't) (not )?(asked|ask|mention)/i, 'asks to be used when the user hasn\'t asked'],
  [/\beven (a|an) (plain|casual|simple|passing)\b/i, 'stretches the trigger to casual mentions'],
  [/\bproactively\b/i, 'asks Claude to call it unprompted'],
  [/\binstead of (answering|reviewing|responding|doing (it|this)|handling it|replying)( it)? (yourself|itself|directly)\b|\binstead of (using|calling|trying) (any |the |other |another |built-in )/i,'tells Claude to use it in place of its own work or other tools (2D/2E)'],
  [/\b(do not|don't|never) use (any )?(other|another|built-in|default)\b/i, 'tells Claude not to use other tools (2E)'],
  [/\bbefore (any|every|each) (other )?(tool|answer|response|reply)\b/i, 'pushes the skill ahead of every other tool'],
  [/\b(anything|everything) (related to|about|involving)\b/i, 'covers "anything related", which is broad'],
  [/\bwhether (claude|you) can do (something|anything)\b/i, 'matches ordinary task requests (Lore Lookup history)'],
  [/\b(highest|top) priority\b/i, 'claims priority over other tools'],
  [/\b(also|or) when (they|the user) (are|is) (working|talking|thinking)\b/i, 'triggers on activity rather than a request'],
];

// Instructions that pull behaviour from outside the plugin (policy 2F).
export const REMOTE_INSTRUCTIONS = [
  /\b(fetch|download|load|read|get)\b[^.\n]{0,80}\b(and|then)\s+(follow|obey|execute|run|apply)\b[^.\n]{0,40}\b(instructions?|steps|commands?|prompts?)\b/i,
  /\bfollow (the )?(instructions|steps|rules) (at|from|in) (https?:\/\/|the (url|page|gist|remote))/i,
  /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(ba|z)?sh\b/i,
  /\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n|]*\|\s*(iex|Invoke-Expression)\b/i,
];

// Download-and-run commands in docs (the directory held Lore Lookup for "Contains a download-and-run command").
export const DOWNLOAD_RUN = [
  [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, 'pipes a download into a shell'],
  [/\b(irm|iwr|Invoke-RestMethod|Invoke-WebRequest)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i, 'pipes a download into Invoke-Expression'],
  [/DownloadString\([^)]*\)[^\n]*(iex|Invoke-Expression)|(iex|Invoke-Expression)[^\n]*DownloadString/i, 'runs a downloaded string'],
  [/\bgit clone\b[^\n]*(&&|;)\s*[^\n]*\b(node|python3?|py|bash|sh|powershell|pwsh|\.\/|install)/i, 'clones and runs in one line'],
  [/\b(npx|bunx|uvx|pipx run|pnpm dlx|yarn dlx)\s+(-y\s+)?[a-z@]/i, 'runs a package straight from a registry'],
];

// Real secrets (FAIL). Shapes only; the checker never reads the user's own secrets.
export const SECRET_SHAPES = [
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, 'GitHub fine-grained token'],
  [/\bgh[ousr]_[A-Za-z0-9]{36}\b/, 'GitHub token'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/\bsk-(proj-)?[A-Za-z0-9]{32,}\b/, 'OpenAI-style API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key ID'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
];

// Names that only look like credentials. The directory's scan held two of our plugins for these
// (a lock ID and some short token-counting names); renaming cleared the hold. WARN only.
export const CREDENTIAL_LOOKALIKE = /\b[A-Za-z_$][A-Za-z0-9_]*(TOKEN|Token|SECRET|Secret|PASSWORD|Password|PASSWD|Passwd|APIKEY|ApiKey|API_KEY|apiKey|api_key|CREDENTIAL|Credential|PRIVATE_KEY|privateKey)[A-Za-z0-9_]*\b|\$(key|token|secret|password|pass|cred)\b|\bTok[A-Z]\b/;

// Reads of environment variables. Credential-like names are the "Uses a credential from the user's
// machine" hold; path variables were also part of what cleared Cutproof's holds (use
// [Environment]::GetFolderPath / os.homedir() instead).
export const ENV_READ = [
  /\$env:([A-Za-z_][A-Za-z0-9_]*)/gi,
  /\bprocess\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g,
  /\bos\.environ(?:\.get)?\(?\[?\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bEnvironment\.GetEnvironmentVariable\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /%([A-Za-z_][A-Za-z0-9_]*)%/g,
  // Shell scripts: $NAME / ${NAME} for upper-case names (lower-case ones are usually local variables).
  /\$\{?([A-Z][A-Z0-9_]{2,})\}?/g,
];
export const ENV_SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)/i;
export const ENV_PATHLIKE = /^(APPDATA|LOCALAPPDATA|USERPROFILE|HOMEPATH|HOMEDRIVE|HOME|ProgramFiles|ProgramFiles\(x86\)|ProgramData|SystemRoot|windir|TEMP|TMP|XDG_[A-Z_]+)$/i;
// Variables Claude Code sets for plugins and skills: fine to read.
export const ENV_ALLOWED = /^(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_CONFIG_DIR|PATH|PATHEXT|NODE_ENV|CI)$/;
// Tests and fixtures: shipped and scanned, but never run by the plugin itself.
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|fixtures)\/|\.(test|spec)\.[a-z]+$/i;

// Code that runs other commands. [regex, label, language test]
export const INJECTION = [
  [/\beval\s+["']?\$|\beval\s+"?\$\(/, 'eval of a variable or command output', SHELL_EXT],
  [/\b(bash|sh|zsh)\s+-c\s+["'][^"']*\$/, 'sh -c with a variable inside the command string', SHELL_EXT],
  [/\bsed\b[^\n|]*["'][^"'\n]*\$\{?[A-Za-z_0-9]/, 'variable inside a sed program (a crafted value can run commands through GNU sed\'s e command)', SHELL_EXT],
  [/\bsource\s+["']?\$|\.\s+["']?\$[A-Za-z_]/, 'sources a file whose path comes from a variable', SHELL_EXT],
  [/\b(Invoke-Expression|iex)\b/i, 'Invoke-Expression runs a string as code', PS_EXT],
  [/\[scriptblock\]::Create\s*\(/i, 'builds a script block from a string', PS_EXT],
  [/\bStart-Process\b[^\n]*-ArgumentList\s+["'][^"'\n]*\$/i, 'Start-Process with an argument string built from variables (quoting breaks on spaces and quotes)', PS_EXT],
  [/(powershell|pwsh)(\.exe)?\s+[^\n]*-Command\s+["'][^"'\n]*\$/i, 'powershell -Command with variables inside the command string', PS_EXT],
  [/\bcmd(\.exe)?\s+\/[ck]\s+[^\n]*\$/i, 'cmd /c with variables in the command line', PS_EXT],
  [/\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^)]*\+)/, 'child_process exec with a command string built from variables (runs through a shell)', JS_EXT],
  [/\bshell\s*:\s*true\b/, 'spawn/execFile with shell: true', JS_EXT],
  [/\b(eval|new Function)\s*\(/, 'eval / new Function', JS_EXT],
  [/\bos\.system\s*\(|\bos\.popen\s*\(/, 'os.system / os.popen run through a shell', PY_EXT],
  [/\bsubprocess\.[a-z_]+\([^)]*shell\s*=\s*True/, 'subprocess with shell=True', PY_EXT],
  [/\b(eval|exec)\s*\(/, 'eval / exec', PY_EXT],
  [/%~?[0-9*][^\n]*(&|\||>)|call\s+%/i, 'batch argument used next to command operators', BATCH_EXT],
];

// Side effects, used to compare what the code does with what the README says (policy 2B, 3C, security scan).
// Each: { id, label, code: regex, readme: regex }
export const SIDE_EFFECTS = [
  { id: 'network', label: 'network requests',
    code: /\bfetch\s*\(|\bhttps?\.(get|request)\s*\(|XMLHttpRequest|new WebSocket\(|Invoke-WebRequest|Invoke-RestMethod|\b(iwr|irm)\s|Net\.WebClient|\bHttpClient\b|\bcurl(\.exe)?\s|\bwget\s|\brequests\.(get|post|put|delete|request)\(|\burllib\.request|\baxios\b|\bWebRequest\]::/i,
    readme: /network|fetch(es|ed)?\b|download|\bsends?\b|\brequests?\b|connects? to|web search|online/i },
  { id: 'registry', label: 'Windows registry changes',
    code: /HKCU:|HKLM:|HKEY_(CURRENT_USER|LOCAL_MACHINE)|\breg(\.exe)?\s+(add|delete|import)\b|Registry(Key)?\]?::|Microsoft\.Win32\.Registry|\b(New|Set|Remove)-ItemProperty\b|\bwinreg\b|CurrentVersion\\\\?Run/i,
    readme: /registry|HKCU|HKEY|Run key|\bRun\b value/i },
  { id: 'shortcut', label: 'shortcuts (Start menu, desktop, startup)',
    code: /\.lnk\b|WScript\.Shell|CreateShortcut|Start Menu|Programs\\\\?Startup|\.desktop\b|IShellLink/i,
    readme: /shortcut/i },
  { id: 'autostart', label: 'start-up entries or scheduled tasks',
    code: /\bschtasks\b|Register-ScheduledTask|\bcrontab\b|\blaunchctl\b|LaunchAgents|systemctl\s+(--user\s+)?enable|CurrentVersion\\\\?Run\b|\bautostart\b/i,
    readme: /start(s|ing)? with windows|startup|start-up|scheduled task|login item|autostart|launch agent|\bRun\b (key|value)/i },
  { id: 'claude-config', label: 'writes to Claude Code settings or config',
    code: /\.claude[\\/]+(settings(\.local)?\.json|keybindings\.json|commands|agents|hooks|skills|CLAUDE\.md)|\bsettings(\.local)?\.json\b/i,
    readme: /settings(\.local)?\.json|~\/\.claude|\.claude[\\/]/i },
  { id: 'home-files', label: 'files outside the project (home, AppData, user folders)',
    code: /%APPDATA%|%LOCALAPPDATA%|%USERPROFILE%|\$env:(APPDATA|LOCALAPPDATA|USERPROFILE)|GetFolderPath\s*\(|\bos\.homedir\s*\(|\bhomedir\s*\(|\bexpanduser\s*\(|Path\.home\s*\(|~[\\/]|\$HOME\b|\$env:HOME\b|SpecialFolder\]?::/i,
    readme: /%APPDATA%|%LOCALAPPDATA%|AppData|home (folder|directory)|~[\\/]|\$HOME|user profile|Documents/i },
  { id: 'temp', label: 'temporary files',
    code: /\btmpdir\s*\(|%TEMP%|\$env:TE?MP\b|GetTempPath|mkdtemp|tempfile\.|\/tmp\/|New-TemporaryFile/i,
    readme: /\btemp\b|temporary|%TEMP%|\/tmp/i },
  { id: 'delete', label: 'deleting files',
    code: /\bRemove-Item\b|\brmSync\s*\(|\bunlinkSync\s*\(|\bunlink\s*\(|\brm\s+-[a-z]*r|\brmdir\b|\bdel\s+\/|\bshutil\.rmtree\b|\bos\.remove\s*\(|File\.Delete\s*\(|Directory\.Delete\s*\(/i,
    readme: /delet|remov|clean(s|ed)? up|overwrit|replac/i },
  { id: 'process', label: 'starting other programs',
    code: /\bspawn(Sync)?\s*\(|\bexec(File)?(Sync)?\s*\(|\bStart-Process\b|\bsubprocess\.|\bos\.system\s*\(|Process\.Start\s*\(|\bAdd-Type\b|\b(ffmpeg|ffprobe|node|python3?|git|npm|npx|msedge|chrome)(\.exe)?\b/i,
    readme: /\bruns?\b|\bstarts?\b|launch|calls?\b|ffmpeg|node|git\b|powershell|python/i },
  { id: 'clipboard-browser', label: 'clipboard or opening a browser',
    code: /Set-Clipboard|\bclip\.exe\b|\s\|\s*clip\s*$|\bpbcopy\b|\bxclip\b|xdg-open|Start-Process\s+['"]?https?:|\bopen\s+['"]?https?:|webbrowser\.open/i,
    readme: /clipboard|browser|opens? (a |the )?(page|link|url)/i },
];

// README claims that something is NOT done; contradicted when the side effect is found in code.
export const NEGATIVE_CLAIMS = [
  { effect: 'network', re: /\b(makes|sends|does) no (network|requests|data)|\bno network (requests|access|calls)\b|never (sends|connects|calls out)|works (fully )?offline|nothing (is )?sent/i },
  { effect: 'registry', re: /\bno registry\b|never (touches|changes|writes to) the registry/i },
  { effect: 'home-files', re: /\bwrites nothing outside\b|never writes outside|only (writes|changes) (files )?(in|inside) (the|your) (repo|project)/i },
  { effect: 'claude-config', re: /never (changes|modifies|touches|writes) (claude code'?s? )?(files|settings|config)/i },
  { effect: 'delete', re: /\bnever deletes?\b|\bdeletes nothing\b/i },
];

// Places that hold chat history, transcripts, memory or session summaries (policy 1G).
export const CHAT_HISTORY = [
  [/\.claude[\\/]+projects\b/i, 'Claude Code transcripts (~/.claude/projects/*.jsonl)', 'FAIL'],
  [/\bhistory\.jsonl\b/i, 'Claude Code prompt history (~/.claude/history.jsonl)', 'FAIL'],
  [/\btranscript(s|_path|Path)?\b/i, 'transcripts', 'WARN'],
  [/\bconversations?\.json\b/i, 'exported claude.ai conversations', 'FAIL'],
  [/\.claude[\\/]+sessions\b/i, 'Claude Code live session registry (~/.claude/sessions)', 'WARN'],
  [/\.claude[\\/]+(todos|shell-snapshots|file-history|plans|paste-cache)\b/i, 'Claude Code session state', 'WARN'],
  [/[\\/]memory[\\/]|\bMEMORY\.md\b|\bauto[- ]?memory\b/i, 'Claude memory files', 'FAIL'],
  [/["']?type["']?\s*[:=]\s*["'](summary|ai-title)["']|\bai-title\b|\bsession summar(y|ies)\b|\bconversation summar(y|ies)\b/i, 'session or conversation summaries', 'FAIL'],
];

// Unsupported use cases (policy 4). Only a prompt for the reviewer, never a verdict.
export const UNSUPPORTED = [
  [/\b(text|image)[- ]to[- ](image|video|speech|audio)\b|\bimage generation\b|\bgenerate (images|videos|audio|music|speech)\b|\bvoice clon/i, '4B AI image, video or audio generation'],
  [/\bcrypto(currency)?\b|\bbitcoin\b|\bwallet\b|\btransfer (money|funds)\b|\bexecute (trades|payments)\b/i, '4A money movement or crypto'],
  [/\badvertis|\bsponsored\b|\bpaid placement/i, '4C advertising'],
  [/\badult content\b|\bnsfw\b|\b18\+/i, '4D adult content'],
];

export const PERSONAL_WEBMAIL = /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.[a-z.]+|live\.[a-z.]+|msn\.com|yahoo\.[a-z.]+|ymail\.com|icloud\.com|me\.com|mac\.com|aol\.com|proton(mail)?\.(me|com|ch)|pm\.me|gmx\.[a-z.]+|mail\.com|yandex\.[a-z]+|zoho\.com|fastmail\.[a-z]+|hey\.com|qq\.com|163\.com)$/i;
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Addresses that are fine to publish.
export const SAFE_EMAIL = /@users\.noreply\.github\.com$|^noreply@anthropic\.com$|^noreply@github\.com$|@example\.(com|org|net|invalid|test)$|\.(invalid|test|example|localhost)$|@example$|@test$|@localhost$|@users\.noreply\.gitlab\.com$|^git@github\.com$/i;
// Placeholder user names that are fine in docs.
const PLACEHOLDER_USER = '(?:Public|Default|you|your[-_ ]?name|your[-_ ]?user(?:name)?|user(?:name)?|name|me|example|someone|runner|USER|<|%|\\{|\\$|\\.\\.\\.)';
export const LOCAL_USER_PATH = new RegExp(`\\b[A-Za-z]:\\\\{1,2}Users\\\\{1,2}(?!${PLACEHOLDER_USER}(?:\\b|\\\\))[A-Za-z0-9._-]+|\\/(?:home|Users)\\/(?!${PLACEHOLDER_USER}(?:\\b|\\/))[a-z0-9._-]+\\/|\\/c\\/Users\\/(?!${PLACEHOLDER_USER}(?:\\b|\\/))[A-Za-z0-9._-]+`, 'i');

export const SYSTEM_FILES = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX)(\/|$)/i;
export const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// Front matter fields a claude.ai skill upload accepts (Agent Skills spec).
export const PORTABLE_SKILL_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
// Claude Code's own skill fields (accepted in plugins; not portable to claude.ai uploads).
export const CLAUDE_CODE_SKILL_FIELDS = new Set(['when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable',
  'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'version']);

export const KNOWN_MANIFEST_KEYS = new Set(['$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository',
  'license', 'keywords', 'metadata', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl', 'defaultEnabled',
  'dependencies', 'settings', 'userConfig', 'types', 'channels', 'skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers',
  'outputStyles', 'workflows', 'experimental', 'themes', 'monitors']);
export const COMPONENT_KEYS = ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'outputStyles', 'workflows', 'types'];

export const RESERVED_WHOLE = new Set(['claude', 'anthropic', 'anthropics', 'claude-code', 'claude-mods', 'official', 'plugin', 'mcp', 'test',
  'plugins', 'skill', 'skills', 'tools', 'example', 'demo']);
export const GENERIC_WORDS = new Set(['test', 'plugin', 'plugins', 'mcp', 'tool', 'tools', 'skill', 'skills', 'helper', 'helpers', 'my', 'demo',
  'example', 'sample', 'utils', 'util', 'kit', 'pack', 'agent', 'agents', 'ai', 'assistant', 'bot', 'code', 'server', 'app', 'new', 'basic',
  'simple', 'official', 'starter', 'template']);

export const HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'UserPromptSubmit', 'SessionStart',
  'SessionEnd', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'PermissionDenied',
  'Setup', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'ConfigChange', 'WorktreeCreate', 'WorktreeRemove', 'InstructionsLoaded',
  'CwdChanged', 'FileChanged', 'Elicitation', 'ElicitationResult', 'UserPromptExpansion', 'PostToolBatch', 'MessageQueued']);
