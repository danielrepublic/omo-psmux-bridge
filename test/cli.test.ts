// Smoke test: src/cli.ts must export main(argv: string[]): Promise<number>.
// Intentionally RED until todo 12 implements the CLI entry point.
import { test, expect } from "bun:test";
import * as cli from "../src/cli";

test("src/cli.ts exports main(argv: string[]): Promise<number>", () => {
  expect(cli).toHaveProperty("main");
});
