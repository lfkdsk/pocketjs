import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The PSP save bridge's path validation and sceIoOpen error classification
// are pure Rust; run their unit tests natively (the psp crate itself is
// no_std and cannot host a test harness, so the core lives in save_core.rs
// with no psp::sys dependency).
const root = join(import.meta.dir, "..");
const build = mkdtempSync(join(tmpdir(), "pocketjs-psp-save-"));
const binary = join(build, "save_core");
afterAll(() => rmSync(build, { recursive: true, force: true }));

beforeAll(() => {
  const result = Bun.spawnSync([
    "rustc", "--edition=2021", "--test", "hosts/psp/src/save_core.rs", "-o", binary,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
}, 60_000);

test("PSP save core: paths and open-error classification", () => {
  const result = Bun.spawnSync([binary], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  const summary = result.stdout.toString().match(/test result: ok\. (\d+) passed; 0 failed/);
  expect(summary, result.stdout.toString()).not.toBeNull();
  expect(Number(summary![1])).toBeGreaterThanOrEqual(6);
});
