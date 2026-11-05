// Writes report.md (pass/warn/fail) and submission-sheet.md (answers for the portal form).

const ORDER = { FAIL: 0, WARN: 1, ALLOWED: 2, INFO: 3, PASS: 4 };
const ICON = { FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO', PASS: 'PASS', ALLOWED: 'ALLOWED' };

const loc = f => f.file ? `\`${f.file}${f.line ? ':' + f.line : ''}\`` : '';
const indent = s => String(s).split('\n').map(l => '  ' + l).join('\n');

export function counts(list) {
  const c = { FAIL: 0, WARN: 0, INFO: 0, PASS: 0, ALLOWED: 0 };
  for (const f of list) c[f.sev]++;
  return c;
}

export function verdict(c) {
  if (c.FAIL) return 'NOT READY: fix every FAIL before you validate in the portal.';
  if (c.WARN) return 'READY TO VALIDATE, with warnings: read each WARN; several are what the portal holds for a reviewer.';
  return 'READY TO VALIDATE: nothing failed or needs a look.';
}

export function renderReport(meta, list, judgement) {
  const c = counts(list);
  const sorted = [...list].sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.id.localeCompare(b.id));
  const out = [];
  out.push(`# Submission check: ${meta.pluginName || meta.repoName}`, '');
  out.push(`- **Verdict:** ${verdict(c)}`);
  out.push(`- **Counts:** ${c.FAIL} FAIL · ${c.WARN} WARN · ${c.INFO} INFO · ${c.PASS} PASS${c.ALLOWED ? ` · ${c.ALLOWED} ALLOWED` : ''}`);
  out.push(`- **Checked:** ${meta.repoRoot} at \`${meta.commit.slice(0, 7)}\`${meta.ref !== 'HEAD' ? ` (ref ${meta.ref})` : ''}${meta.worktree ? ' — working tree mode (uncommitted files included)' : ' — committed files, read through a GitHub-like git archive'}`);
  out.push(`- **Plugin folder:** \`${meta.pluginDir || '.'}\` (portal Plugin path: ${meta.pluginDir ? `\`${meta.pluginDir}\`` : 'leave empty'})`);
  out.push(`- **Rules:** Anthropic Software Directory Policy (support.claude.com/en/articles/13145358) and the plugin pre-submission checklist, as of ${meta.rulesDate}; plus problems Ablation Lab's own submissions ran into.`);
  if (meta.notes.length) for (const n of meta.notes) out.push(`- **Note:** ${n}`);
  out.push('', 'FAIL = the portal blocks or stops, or a clear policy problem. WARN = likely held for a reviewer, or worth fixing first. INFO = facts for the sheet. A clean run is not approval: Anthropic\'s reviewers and security scan still decide.', '');
  for (const sev of ['FAIL', 'WARN', 'ALLOWED', 'INFO', 'PASS']) {
    const items = sorted.filter(f => f.sev === sev);
    if (!items.length) continue;
    out.push(`## ${ICON[sev]} (${items.length})`, '');
    for (const f of items) {
      const tags = [f.policy && `policy ${f.policy}`, f.portal && `portal: ${f.portal}`].filter(Boolean).join(' · ');
      out.push(`- **[${f.id}] ${f.title}** ${loc(f)}${tags ? ` _(${tags})_` : ''}`);
      if (f.detail) out.push(indent(f.detail));
      if (f.fix && (sev === 'FAIL' || sev === 'WARN')) out.push(indent(`Fix: ${f.fix}`));
      if (f.allowedReason) out.push(indent(`Allowed by .plugin-check-allow.json: ${f.allowedReason}`));
    }
    out.push('');
  }
  out.push('## Judgement checks (for Claude, after reading the code)', '');
  out.push('The script finds evidence; these need a reader. The skill fills this section in.', '');
  for (const j of judgement) out.push(`- [ ] ${j}`);
  out.push('');
  return out.join('\n');
}

function yesNo(b) { return b ? 'Yes' : 'No'; }

export function renderSheet(meta, facts) {
  const m = facts.manifest || {};
  const r = facts.readme || {};
  const code = facts.code || { effects: [], hosts: [] };
  const comp = facts.components || { skills: [], commands: [], agents: [] };
  const eff = id => code.effects.find(e => e.id === id);
  const out = [];
  out.push(`# Submission sheet: ${m.displayName || m.name || meta.repoName}`, '');
  out.push(`Prepared by the submission-check skill on ${meta.date} from \`${meta.commit.slice(0, 7)}\`. Answers marked **DRAFT** were inferred from the code and README; check each one before you paste it.`, '');
  out.push('- Portal: https://claude.ai/directory/manage, then **Submit new**, then **Plugin bundle**.');
  out.push('- Docs: [Submit your plugin](https://claude.com/docs/plugins/submit), [Pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist), [Directory Policy](https://support.claude.com/en/articles/13145358).');
  out.push(`- Check report: ${meta.counts.FAIL} FAIL, ${meta.counts.WARN} WARN (see report.md). Fix every FAIL first.`, '');

  out.push('## Before you start', '');
  out.push('- A paid plan (Pro, Max, Ultra, Team or Enterprise). On Team or Enterprise an Owner submits. The listing belongs to the organization you submit from and can\'t be moved.');
  out.push('- Connect GitHub in that same Claude organization; the connected account must be able to push to the repo.');
  if (meta.remote?.ownerRepo) out.push(`- The repo must be on GitHub with the checked commit pushed${meta.unpushed ? ` — **${meta.unpushed} local commit(s) aren't pushed yet**` : ''}.`);
  else out.push('- **No GitHub remote yet.** Create the repo on GitHub and push before you validate. A private repo can be validated and submitted (install the Claude GitHub App and agree to the source upload), but it must be public before the listing goes live.');
  out.push('- Each submission uses one of your organization\'s 10 submissions per 24 hours.', '');

  out.push('## 1. Source', '');
  out.push('**Repository**', '```', meta.remote?.ownerRepo || '<owner>/<repo>  (no GitHub remote found)', '```');
  out.push(`**Plugin path**: ${meta.pluginDir ? `required, type exactly:\n\`\`\`\n${meta.pluginDir}\n\`\`\`` : 'leave empty (plugin.json is at the repo root).'}`);
  out.push(`**Branch or tag**: leave empty to follow the default branch${meta.branch ? ` (\`${meta.branch}\` here)` : ''}.`, '');
  out.push('Select **Validate**. Fix anything marked **Blocking**, push, then **Re-validate** (a report covers one commit).', '');

  out.push('## 2. Listing details (read from the repo; check them)', '');
  out.push('| Field | Value |', '|---|---|');
  const row = (k, v) => out.push(`| ${k} | ${v ?? '_not set_'} |`);
  row('Plugin name (permanent)', m.name && `\`${m.name}\``);
  row('Display name', m.displayName);
  row('Version', m.version && `${m.version}${facts.mpEntry?.version ? (facts.mpEntry.version === m.version ? ' (same in marketplace.json)' : ` (**marketplace.json says ${facts.mpEntry.version}**)`) : ''}`);
  row('Author', m.author?.name);
  row('Icon', facts.icon && `\`${facts.icon}\``);
  row('Documentation URL', m.documentationUrl);
  row('Support URL', m.supportUrl);
  row('Privacy policy URL', m.privacyPolicyUrl);
  row('Terms of service URL (optional)', m.termsOfServiceUrl || '_not set (optional)_');
  row('Homepage / repository', m.homepage || m.repository);
  row('README (listing description)', r.path && `\`${r.path}\``);
  row('Licence', m.license ? `${m.license}` : (facts.licenseFile ? 'LICENSE file' : '_missing_'));
  row('Classification (optional)', [Array.isArray(m.keywords) && m.keywords.length && `keywords: ${m.keywords.join(', ')}`, facts.category && `category: ${facts.category}`, Array.isArray(facts.tags) && `tags: ${facts.tags.join(', ')}`].filter(Boolean).join('; ') || '_none (optional)_');
  const comps = [comp.skills.length && `${comp.skills.length} skill(s): ${comp.skills.map(s => s.name).join(', ')}`, comp.commands.length && `${comp.commands.length} command(s)`, comp.agents.length && `${comp.agents.length} agent(s)`, comp.hooks && 'hooks', comp.mcp?.length && `${comp.mcp.length} MCP server(s)`].filter(Boolean).join('; ');
  row('Components', comps || 'none found');
  out.push('', '**Description** (from plugin.json)', '```', m.description || '(none)', '```', '');

  out.push('### Listed on (surfaces)', '');
  out.push('The portal works these out from what the plugin contains and shows them before you submit:', '');
  const s = surfaces(comp, facts);
  for (const line of s) out.push(`- ${line}`);
  out.push('');

  out.push('## 3. Data handling (suggested answers)', '');
  const reads = [];
  if (eff('home-files')) reads.push('files outside the project (home or app-data folders)');
  if (facts.chat?.length) reads.push('Claude Code session data (see the 1G finding)');
  out.push(`**Reads or stores personal data:** DRAFT — ${reads.length ? 'Yes, on the user\'s computer only' : 'No'}.`);
  out.push('```');
  out.push(reads.length
    ? `Only on the user's computer. It reads ${reads.join(' and ')} and writes ${writesSummary(eff)}. Nothing is collected or sent to the developer.`
    : `No. It works on the files the user points it at in their own project and keeps nothing about the user. Nothing is collected or sent to the developer.`);
  out.push('```');
  const net = eff('network'), hosts = code.hosts || [];
  const fetchesByClaude = facts.webTools;
  out.push(`**Sends data to services other than its declared connectors:** DRAFT — ${net || fetchesByClaude ? 'Yes (disclosing is the safer answer)' : 'No'}.`);
  out.push('```');
  if (net || fetchesByClaude) out.push(`Yes${net && hosts.length ? `, to: ${hosts.join(', ')}` : ''}. ${fetchesByClaude ? 'Claude\'s own web fetch or search tools read public pages the skill names. ' : ''}${net ? 'The plugin\'s scripts make requests (see the README\'s "What it runs, reads and writes"). ' : ''}No telemetry and no account.`);
  else out.push('No. The plugin makes no network requests of its own. Files reach Anthropic only the way anything in the conversation does, when Claude reads them.');
  out.push('```');
  if (!net && hosts.length) out.push(`_Hosts named in the code but with no request code found: ${hosts.join(', ')} (links in messages or docs). Check none is contacted._`);
  out.push('**How long it keeps data:** DRAFT', '```', `Nothing is kept by the developer. On the user's computer, ${writesSummary(eff)} stay until the user deletes them.`, '```');
  out.push('**Intended for people under 18:** No (change if your audience includes minors).', '');

  out.push('## 4. Compliance', '');
  out.push('- Check the contact email is one where Anthropic can reach you about this submission (it comes from your account; it isn\'t published in the listing).');
  out.push('- Select all four acknowledgements (Directory Terms, Directory Policy, and the others the form lists).', '');

  out.push('## 5. Review and submit', '');
  out.push('- **How new versions reach the directory:** keep **GitHub push webhook** (default; needs admin on the repo to set up), or **Scheduled check only**.');
  out.push('- **Auto-publish passing versions:** your choice; a reviewer still publishes the first version.');
  out.push('- Select **Submit for review**.', '');

  out.push('## Example prompts (policy 3E: at least three)', '');
  if (r.prompts?.length) { out.push('```'); for (const p of r.prompts.slice(0, 6)) out.push(p); out.push('```'); }
  else out.push('_None found in the README — add at least three._');
  out.push('');
  out.push('## Test setup with sample data (policy 3D)', '');
  if (r.sampleDirs?.length || r.sampleSection) out.push(`- Sample files: ${r.sampleDirs?.length ? r.sampleDirs.map(d => `\`${d}\``).join(', ') : '_none in the plugin folder_'}`, `- README section: ${r.sampleSection ? `"${r.sampleSection}"` : '_none_'}`, '- No account is needed for a local plugin; say so in the README\'s reviewer section.');
  else out.push('_No sample data found. Add a samples/ folder (or a script that makes one) and a "For reviewers" section._');
  out.push('');
  out.push('## What it runs, sends and writes (from the code; must match the README)', '');
  if (code.effects.length) for (const e of code.effects) out.push(`- ${e.label}: ${e.count} place(s), ${e.mentioned ? 'mentioned in the README' : '**not found in the README**'} (e.g. \`${e.examples[0].file}:${e.examples[0].line}\`)`);
  else out.push('- No programs, writes or network requests found in the plugin\'s code.');
  if (hosts.length) out.push(`- Hosts named in code: ${hosts.join(', ')}`);
  out.push('');
  return out.join('\n');
}

function writesSummary(eff) {
  const w = [];
  if (eff('home-files')) w.push('files in its own folder under the user\'s home or app-data directory');
  if (eff('temp')) w.push('temporary files');
  if (eff('registry')) w.push('a registry value');
  if (eff('shortcut')) w.push('a shortcut');
  if (!w.length) return 'only the files it creates where the user asks';
  return w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
}

function surfaces(comp, facts) {
  const lines = [];
  const scriptsSkill = comp.skills.some(s => /\$\{CLAUDE_SKILL_DIR\}|\bnode\b|\bpowershell\b|\bpython3?\b|\bbash\b|\.ps1\b|\.sh\b/.test(s.fm?.body || ''));
  if (comp.bin) lines.push('**Claude Code only**: a top-level bin/ folder makes chat and Cowork refuse to install it.');
  else {
    if (comp.skills.length) lines.push(`Skills load in **chat, Cowork and Claude Code**.${scriptsSkill ? ' This skill runs local scripts, so it only fully works where it can run them (Claude Code; Cowork when its session runs on your computer). Say this in the README\'s "Where it works".' : ''}`);
    if (comp.commands.length) lines.push('Commands: chat loads them as skills; Cowork and Claude Code load them as commands.');
    if (comp.agents.length) lines.push('Agents: Cowork and Claude Code (ignored in chat).');
    if (comp.hooks) lines.push('Hooks: Cowork and Claude Code (ignored in chat).');
    if (comp.mcp?.length) lines.push('MCP: remote servers work everywhere once connected; local (command) servers only in Claude Code and Cowork on your computer.');
  }
  return lines.length ? lines : ['No components found.'];
}
