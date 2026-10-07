import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The PSP save bridge's record validation and write/delete state machines are
// pure Rust; run their fault sweep natively (the psp crate itself is no_std
// and cannot host a test harness, so the core has no psp::sys dependency).
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

test("PSP save core: integrity and crash-safe transaction fault sweep", () => {
  const result = Bun.spawnSync([binary], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(0);
  const summary = result.stdout.toString().match(/test result: ok\. (\d+) passed; 0 failed/);
  expect(summary, result.stdout.toString()).not.toBeNull();
  expect(Number(summary![1])).toBeGreaterThanOrEqual(14);

  const listed = Bun.spawnSync([binary, "--list"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(listed.exitCode, `${listed.stdout}${listed.stderr}`).toBe(0);
  const names = listed.stdout.toString();
  expect(names).toContain("every_write_step_failure_and_power_cut_keeps_an_old_or_new_save");
  expect(names).toContain("sole_backup_retry_never_removes_the_backup_before_new_live_exists");
  expect(names).toContain("retry_after_each_power_cut_survives_every_second_failure");
  expect(names).toContain("delete_reports_each_failure_without_a_backup_resurrection");
});
