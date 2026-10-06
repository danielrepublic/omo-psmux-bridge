// Fetch (or confirm) the pinned psmux source tree for contract verification.
//
// The tree CONTRACT.md cites lives at the srcRoot named in pins.json, at the
// exact pinned commit. If the directory does not exist, clone it fresh,
// fetch every ref (the ancestry checks in CONTRACT.md need commits past the
// pinned tag), and check out the pinned commit. If it does exist, compare its
// HEAD against the pin and stop with an error on mismatch: never silently
// re-clone or hard-reset, because a user may have local work there.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { expandBundleGlob, findRepoRoot, loadPins } from "./verify-citations.ts";

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function main(): number {
  // Resolved from this file's own location so the script works from any cwd.
  const root = findRepoRoot(import.meta.dir);
  const pins = loadPins(join(root, "scripts", "contract", "pins.json"));
  const omoBundleFile = expandBundleGlob(pins.omo.bundleGlob, pins.omo.verifiedAgainst, homedir());
  const psmuxDir = join(root, pins.psmux.srcRoot);
  console.log(`contract:fetch: omo bundle: ${omoBundleFile}`);
  console.log(`contract:fetch: psmux tree: ${psmuxDir}`);
  if (!existsSync(psmuxDir)) {
    sh("git", ["clone", pins.psmux.repo, psmuxDir], root);
    // A plain clone already has the default refs, but the ancestry checks need
    // post-tag commits unreachable from the pinned tag alone, so fetch every
    // ref explicitly to reproduce the working copy's state.
    sh("git", ["fetch", "origin", "+refs/*:refs/remotes/origin/*"], psmuxDir);
    sh("git", ["checkout", pins.psmux.commit], psmuxDir);
    console.log(`contract:fetch: cloned ${pins.psmux.tag} (${pins.psmux.commit})`);
    return 0;
  }
  let head: string;
  try {
    head = sh("git", ["rev-parse", "HEAD"], psmuxDir).trim();
  } catch {
    console.error(
      `contract:fetch: refusing to touch ${psmuxDir}: it is not a git checkout, so the pinned ${pins.psmux.tag} tree cannot be confirmed there`,
    );
    return 1;
  }
  if (head !== pins.psmux.commit) {
    console.error(
      `contract:fetch: refusing to touch ${psmuxDir}: HEAD is ${head}, pins.json wants ${pins.psmux.commit} (${pins.psmux.tag})`,
    );
    return 1;
  }
  console.log(`contract:fetch: psmux tree already at ${pins.psmux.commit}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
