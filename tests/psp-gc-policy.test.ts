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
  const summary = result.stdout.toString().match(/test result: ok\. (\d+) passed; 0 failed/);
  expect(summary, result.stdout.toString()).not.toBeNull();
  expect(Number(summary![1])).toBeGreaterThanOrEqual(8);
});
