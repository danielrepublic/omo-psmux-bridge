#!/usr/bin/env node
/*
 * e2e-team-v030.cjs — REAL OmO team-mode E2E against the INSTALLED v0.3.0 shim.
 *
 * Methodology: .omo/evidence/issue-1-e2e-team-mode.txt (2026-10-06 PASS run).
 *   - Throwaway project %TEMP%\\omo-v030-e2e with project-local .omo/omo.jsonc
 *     enabling team_mode + tmux_visualization (project layer merges over user).
 *   - Fresh session with a UNIQUE name in the DEFAULT namespace, opencode TUI
 *     launched in the pane, asked once to team_create a single-member team.
 *   - PASS: member pane appears with omo title + ~30/70 geometry; captures kept.
 *   - Cleanup: kill-session -t <unique> ONLY; pre-existing sessions verified
 *     intact by name; psmux.exe count verified unchanged. NEVER kill-server here
 *     (default namespace: a kill-server would hit the user's live servers).
 *
 * NAMESPACE DEVIATION (documented, inherited from issue-1): OmO's plugin cannot
 * operate under -L (session targets like <session>:0 do not resolve inside a
 * namespaced server while OmO's own clients carry no -L; see the harness note in
 * issue-1-e2e-team-mode.txt). Isolation is by UNIQUE session name + targeted
 * kill-session instead. The release E2E brief orders this methodology.
 *
 * Run on Windows in a SINGLE ssh invocation (owns its lifetime).
 *   node e2e-team-v030.cjs <workDir> <reportJsonPath>
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MUX_MS = 30000;
const TUI_READY_MS = 120000;
const TEAM_WAIT_MS = 420000;
const POLL_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => process.stdout.write(s + '\n');

const SHIM = path.join(process.env.LOCALAPPDATA || '', 'opencode-psmux-bridge', 'bin', 'tmux.exe');
const OMO_BUNDLE = path.join(os.homedir(), '.cache', 'opencode', 'packages', 'oh-my-openagent@latest', 'node_modules', 'oh-my-openagent', 'dist', 'index.js');

function run(bin, args, timeoutMs) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs || MUX_MS, shell: false, windowsHide: true });
  if (r.error) return { exit: -1, out: `spawn error: ${r.error.message}`, err: '' };
  return { exit: r.status ?? -1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}
function psCount() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-Process -Name 'psmux' -ErrorAction SilentlyContinue).Count"],
    { encoding: 'utf8', timeout: MUX_MS, shell: false, windowsHide: true });
  return String(r.stdout || '').trim();
}

(async () => {
  const workDir = process.argv[2];
  const reportPath = process.argv[3] || path.join(workDir, 'e2e-team-report.json');
  const R = Math.floor(Math.random() * 1e6);
  const SESSION = `omo-v030-e2e-${R}`;
  const TEAM = `e2e-v030-${R}`;
  const MEMBER = `probe-member-v030`;
  const MARKER = `E2E-MEMBER-OK-${R}`;
  const projectDir = path.join(os.tmpdir(), 'omo-v030-e2e');
  const report = {
    tool: 'e2e-team-v030.cjs', ok: false, session: SESSION, team: TEAM, member: MEMBER,
    checks: [], baseline: {}, cleanup: {}, notes: '',
  };
  const check = (name, pass, detail) => {
    report.checks.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${String(detail).slice(0, 160)}`);
    return !!pass;
  };

  const mux = (args) => run(SHIM, args); // default namespace BY DESIGN (see header)
  let cleaned = false;
  async function cleanup(reason) {
    if (cleaned) return;
    cleaned = true;
    const k = mux(['kill-session', '-t', SESSION]);
    const ls = mux(['list-sessions', '-F', '#{session_name}']);
    const after = ls.exit === 0 ? ls.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
    const gone = !after.includes(SESSION);
    const intact = report.baseline.sessions
      ? report.baseline.sessions.every((s) => after.includes(s)) : '(no baseline)';
    report.cleanup = {
      reason, killSession: `exit=${k.exit} ${k.out.slice(0, 120)}`,
      sessionsAfter: after, targetGone: gone, baselineIntact: intact,
      psmuxBefore: report.baseline.psmuxCount, psmuxAfter: psCount(),
    };
    check('cleanup-target-gone', gone, `session ${SESSION} gone=${gone}`);
    check('cleanup-baseline-intact', intact === true, `pre-existing sessions intact=${intact}`);
    check('cleanup-psmux-count', String(report.cleanup.psmuxAfter) === String(report.baseline.psmuxCount),
      `psmux.exe before=${report.baseline.psmuxCount} after=${report.cleanup.psmuxAfter}`);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (e) { log(`project cleanup: ${e.message}`); }
  }

  try {
    check('shim-present', fs.existsSync(SHIM), SHIM);
    if (!fs.existsSync(SHIM)) throw new Error('no installed shim');

    // Baseline: existing sessions (default ns) + psmux count. Nothing touched yet.
    const base = mux(['list-sessions', '-F', '#{session_name}']);
    report.baseline.sessions = base.exit === 0 ? base.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
    report.baseline.psmuxCount = psCount();
    log(`baseline sessions: ${JSON.stringify(report.baseline.sessions)} psmux=${report.baseline.psmuxCount}`);
    if (report.baseline.sessions.includes(SESSION)) throw new Error('session collision (impossible)');

    // Contract precheck: team_mode keys + team_create/team_send_message in the bundle.
    let bundle = '';
    try { bundle = fs.readFileSync(OMO_BUNDLE, 'utf8'); }
    catch (e) { check('bundle-readable', false, e.message); throw new Error('cannot read OmO bundle'); }
    const hasTeamMode = bundle.includes('team_mode') && bundle.includes('tmux_visualization');
    const hasTeamTools = bundle.includes('team_create') && bundle.includes('team_send_message');
    check('bundle-team-mode-keys', hasTeamMode, 'team_mode + tmux_visualization in 5.1.35 bundle');
    check('bundle-team-tools', hasTeamTools, 'team_create + team_send_message in bundle');
    if (!hasTeamMode || !hasTeamTools) throw new Error('BLOCKED: OmO bundle no longer carries the team-mode keys this E2E needs');

    // Throwaway project with team_mode visualization on.
    fs.mkdirSync(path.join(projectDir, '.omo'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.omo', 'omo.jsonc'),
      JSON.stringify({ '[opencode]': { tmux: { enabled: true }, team_mode: { enabled: true, tmux_visualization: true } } }, null, 2));
    check('project-ready', true, projectDir);

    // Fresh uniquely-named session (default ns), verify `tmux` resolves to the shim in-pane.
    const ns = mux(['new-session', '-d', '-s', SESSION, '-x', '220', '-y', '50', '-P', '-F', '#{pane_id}']);
    const caller = (ns.out.match(/%\d+/) || [''])[0];
    check('e2e-new-session', ns.exit === 0 && !!caller, `session=${SESSION} caller=${caller || '?'}`);
    if (!caller) throw new Error('new-session gave no pane');
    const w = mux(['send-keys', '-t', caller, 'where.exe tmux', 'Enter']);
    await sleep(3000);
    const wcap = mux(['capture-pane', '-p', '-t', caller]);
    const shimFirst = wcap.out.split(/\r?\n/).find((l) => l.includes('tmux.exe'));
    check('in-pane-tmux-is-shim', !!shimFirst && shimFirst.includes('opencode-psmux-bridge'),
      (shimFirst || '(no where line)').slice(0, 160));

    // Launch the opencode TUI from the project dir.
    mux(['send-keys', '-t', caller, `cd /d ${projectDir}`, 'Enter']);
    await sleep(1500);
    mux(['send-keys', '-t', caller, 'opencode', 'Enter']);
    let ready = false, tuiSample = '';
    const t0 = Date.now();
    while (Date.now() - t0 < TUI_READY_MS) {
      const c = mux(['capture-pane', '-p', '-t', caller]);
      tuiSample = c.out;
      if (/Sisyphus|opencode| ultraworker |Agent/i.test(tuiSample) && tuiSample.length > 500) { ready = true; break; }
      await sleep(POLL_MS);
    }
    check('tui-ready', ready, `tui chrome detected=${ready}`);
    if (!ready) { report.notes = 'TUI never reached a prompt-ready state; capture kept.'; report.tuiSample = tuiSample.slice(-2000); throw new Error('BLOCKED: opencode TUI not ready'); }

    // Ask once for a single-member team.
    const prompt = `Please call team_create exactly once to create team ${TEAM} with one member named ${MEMBER}. The member task is: print ${MARKER} with the echo command, then call team_send_message to lead with that marker and go idle. Do nothing else.`;
    mux(['send-keys', '-t', caller, prompt, 'Enter']);
    check('prompt-sent', true, `team_create request typed (${prompt.length} chars)`);

    // Poll for the teammate pane.
    let panes = [], memberPane = null, geoAfter = [];
    const t1 = Date.now();
    while (Date.now() - t1 < TEAM_WAIT_MS) {
      const lp = mux(['list-panes', '-t', `${SESSION}:0`, '-F', '#{pane_id} #{pane_index} #{pane_title} #{pane_left} #{pane_width}']);
      if (lp.exit === 0) {
        panes = lp.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        geoAfter = panes;
        memberPane = panes.find((l) => /probe-member|omo-team/i.test(l));
        if (memberPane && panes.length >= 2) break;
      }
      await sleep(POLL_MS);
    }
    report.geometry = geoAfter;
    check('team-pane-appeared', !!memberPane, memberPane || `panes=${JSON.stringify(panes).slice(0, 160)}`);
    if (!memberPane) {
      const mc = mux(['capture-pane', '-p', '-t', caller]);
      report.mainSample = mc.out.slice(-3000);
      report.notes = 'No teammate pane appeared within budget; main-pane tail kept for diagnosis.';
      throw new Error('FAIL: teammate pane did not appear');
    }
    // Geometry: caller ~30% of 220.
    const callerGeo = geoAfter.find((l) => l.startsWith(caller)) || geoAfter[0] || '';
    const parts = callerGeo.split(/\s+/);
    const width = parseInt(parts[parts.length - 1], 10);
    check('caller-geometry-30pct', width >= 55 && width <= 77, `caller geometry: ${callerGeo} (expect width ~66/220)`);
    // Member marker in its pane.
    const mid = (memberPane.match(/%\d+/) || [''])[0];
    let markerSeen = false, memberSample = '';
    const t2 = Date.now();
    while (Date.now() - t2 < 120000) {
      const c = mux(['capture-pane', '-p', '-t', mid]);
      memberSample = c.out;
      if (memberSample.includes(MARKER)) { markerSeen = true; break; }
      await sleep(POLL_MS);
    }
    report.memberSample = memberSample.slice(-3000);
    check('member-marker', markerSeen, markerSeen ? `${MARKER} rendered in member pane` : 'marker absent within 120s');
    const mc2 = mux(['capture-pane', '-p', '-t', caller]);
    report.mainSample = mc2.out.slice(-2000);

    // Shim call-log: expect the team sequence (display rewrite, suppression, resize rewrite).
    try {
      const logPath = path.join(path.dirname(SHIM), 'state', 'shim-calls.jsonl');
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
      const recent = lines.slice(-40).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const verbs = recent.map((r) => `${r.verb}:${r.kind || ''}${r.rewriteReason ? '(rw)' : ''}${r.suppressionReason ? '(sup)' : ''}`);
      report.shimRecent = verbs;
      log(`shim recent: ${verbs.join(' ')}`.slice(0, 500));
    } catch (e) { log(`shim log read: ${e.message}`); }

    report.ok = report.checks.every((c) => c.pass);
  } catch (e) {
    report.fatal = String((e && e.message) || e);
    log(`ABORT: ${report.fatal}`);
    report.ok = false;
  } finally {
    await cleanup(report.fatal || 'done');
    report.ok = report.checks.every((c) => c.pass);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log(`report ${report.ok ? 'OK' : 'FAIL'} -> ${reportPath}`);
    process.exit(report.ok ? 0 : 1);
  }
})();
