// A real interrupt during a real run: Seaready is started as its own process, and partway through (while
// `claude plugin validate` is running) it gets a real Ctrl+C. On Windows that is a console Ctrl+C event
// sent with GenerateConsoleCtrlEvent to Seaready's own hidden console; elsewhere it is SIGINT. The run
// must stop promptly and not finish its report. (A run stopped this way may leave a temporary folder;
// that is in the README's Limits.) The `claude` it finds is a stand-in that only waits, so the run is
// slow at a known point and no real claude CLI is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repo, cleanPlugin, tmpDir, configDir, write } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const checkJs = path.join(here, '..', 'plugin', 'skills', 'submission-check', 'scripts', 'check.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const WAIT_MS = 15000;      // how long the stand-in claude waits; the run can't finish sooner
const PROMPT_MS = 5000;     // how soon after the interrupt the run must be gone

// Starts Seaready in a new hidden console. Ignoring Ctrl+C is inherited on Windows, and the process that
// runs the tests may have been started that way, so the launcher turns normal Ctrl+C handling back on
// for itself first; Seaready then starts as it would from a normal terminal.
const START_PS1 = [
  'param($node, $script, $repo, $out)',
  "Add-Type -Name K -Namespace CtrlOn -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);'",
  '[void][CtrlOn.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)',
  '$argline = \'"\' + $script + \'" "\' + $repo + \'" --out "\' + $out + \'"\'',
  '$p = Start-Process -FilePath $node -ArgumentList $argline -WindowStyle Hidden -PassThru',
  '$p.Id',
].join('\r\n');
const CTRLC_PS1 = [
  'param([int]$target)',
  "Add-Type -Name K -Namespace CtrlC -MemberDefinition @'",
  '[DllImport("kernel32.dll")] public static extern bool FreeConsole();',
  '[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);',
  '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);',
  '[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e, uint g);',
  "'@",
  '[void][CtrlC.K]::FreeConsole()',
  'if (-not [CtrlC.K]::AttachConsole($target)) { Write-Output "attach failed"; exit 3 }',
  '[void][CtrlC.K]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)',
  'if (-not [CtrlC.K]::GenerateConsoleCtrlEvent(0, 0)) { Write-Output "send failed"; exit 4 }',
  'Write-Output "sent"',
].join('\r\n');
const ps = (file, args, env) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { env, encoding: 'utf8', timeout: 60000, windowsHide: true }).trim();

test('a real Ctrl+C partway through a run stops it promptly', { timeout: 120000 }, async () => {
  const root = repo(cleanPlugin());
  const t = tmpDir('seaready-tempdir-');
  const out = tmpDir('seaready-out-');
  const bin = tmpDir('seaready-bin-');
  // The stand-in claude: records its pid (so the test can end it), then waits.
  write(bin, 'fake-claude.mjs', `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(bin, 'fake.pid'))}, String(process.pid));\nsetTimeout(() => {}, ${WAIT_MS});\n`);
  if (process.platform === 'win32') write(bin, 'claude.cmd', `@"${process.execPath}" "${path.join(bin, 'fake-claude.mjs')}" %*\r\n`);
  else { write(bin, 'claude', `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'fake-claude.mjs')}" "$@"\n`); fs.chmodSync(path.join(bin, 'claude'), 0o755); }
  const env = { ...process.env, PATH: bin + path.delimiter + (process.env.PATH || ''), TEMP: t, TMP: t, TMPDIR: t, CLAUDE_CONFIG_DIR: configDir() };
  delete env.NODE_TEST_CONTEXT;

  let pid, child = null;
  if (process.platform === 'win32') {
    write(bin, 'start.ps1', START_PS1);
    write(bin, 'ctrlc.ps1', CTRLC_PS1);
    pid = Number(ps(path.join(bin, 'start.ps1'), [process.execPath, checkJs, root, out], env).split(/\s+/).pop());
  } else {
    child = spawn(process.execPath, [checkJs, root, '--out', out], { env, stdio: 'ignore' });
    pid = child.pid;
  }
  assert.ok(pid > 0, 'Seaready started');
  try {
    // Partway: wait until the validate step (the stand-in claude) is running.
    const t0 = Date.now();
    while (!fs.existsSync(path.join(bin, 'fake.pid')) && Date.now() - t0 < 30000) await sleep(100);
    assert.ok(fs.existsSync(path.join(bin, 'fake.pid')), 'the run reached the validate step');
    assert.ok(alive(pid), 'Seaready is still running when interrupted');

    const sentAt = Date.now();
    if (process.platform === 'win32') assert.equal(ps(path.join(bin, 'ctrlc.ps1'), [String(pid)], env), 'sent');
    else child.kill('SIGINT');
    while (alive(pid) && Date.now() - sentAt < PROMPT_MS + 2000) await sleep(100);
    const tookMs = Date.now() - sentAt;

    assert.ok(!alive(pid), `Seaready was still running ${tookMs} ms after the interrupt`);
    assert.ok(tookMs < PROMPT_MS, `took ${tookMs} ms to stop`);
    assert.ok(!fs.existsSync(path.join(out, 'report.json')), 'the interrupted run did not finish its report');
  } finally {
    for (const p of [pid, Number(fs.existsSync(path.join(bin, 'fake.pid')) ? fs.readFileSync(path.join(bin, 'fake.pid'), 'utf8') : 0)]) {
      if (p > 0 && alive(p)) { try { process.kill(p); } catch { /* already gone */ } }
    }
    await sleep(300);
  }
});
