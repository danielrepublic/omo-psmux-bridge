import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const nativeTest = process.platform === "win32" ? test : test.skip;

// Extract only the shipped installer's migration functions: the probe exercises
// PATH ownership and real state files without executing registry-writing code.
nativeTest("legacy installation migration preserves PATH ownership and state on Windows PowerShell 5.1", () => {
  const work = mkdtempSync(join(tmpdir(), "omo-migration-test-"));
  const powershell = join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  try {
    const result = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      join(ROOT, "scripts/windows/harness/install-migration-probe.ps1"),
      "-InstallPs1", join(ROOT, "scripts/windows/bin/install.ps1"),
      "-WorkDir", work,
    ], { encoding: "utf8", timeout: 60_000, windowsHide: true });

    const reportPath = join(work, "install-migration-report.txt");
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "<probe report missing>";
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr, report }).toMatchObject({ status: 0 });
    const totals = /ASSERT TOTALS: pass=(\d+) fail=(\d+)/.exec(report);
    expect(totals).not.toBeNull();
    expect(Number(totals?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(totals?.[2])).toBe(0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);
