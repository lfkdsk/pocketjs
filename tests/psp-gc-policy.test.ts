import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The PSP frame loop's GC trigger is pure Rust; run its unit tests natively.
const root = join(import.meta.dir, "..");
const build = mkdtempSync(join(tmpdir(), "pocketjs-psp-gc-policy-"));
const binary = join(build, "gc_policy");
afterAll(() => rmSync(build, { recursive: true, force: true }));

beforeAll(() => {
  const result = Bun.spawnSync([
    "rustc", "--edition=2021", "--test", "hosts/psp/src/gc_policy.rs", "-o", binary,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
}, 60_000);

test("PSP GC trigger policy", () => {
  const result = Bun.spawnSync([binary], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  expect(result.stdout.toString()).toContain("6 passed; 0 failed");
});
