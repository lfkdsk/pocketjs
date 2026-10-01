#!/usr/bin/env bun
// Normalize objects from the pinned PSP GNU assembler for Rust's LLVM linker.
// Allegrex's vendor machine tag collides with LLVM's Loongson tag. Both the
// PSP Clang and GCC single-float builds pass software doubles in integer
// registers; the SDK's FP attribute uses a different name for that ABI.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const compiler = process.env.POCKETJS_PSP_GCC;
const objcopy = process.env.POCKETJS_PSP_OBJCOPY;
if (!compiler || !objcopy) throw new Error("PSP GCC wrapper requires the pinned SDK and LLVM paths");
const args = process.argv.slice(2);
const compiled = Bun.spawnSync([compiler, ...args], { stdout: "inherit", stderr: "inherit" });
if (compiled.exitCode !== 0) process.exit(compiled.exitCode);
if (args.includes("-c") && args.includes("-o")) {
  const output = args[args.indexOf("-o") + 1]!;
  const temporary = `${output}.normalized`;
  // Rewriting the symbol table also repairs the GNU assembler's local-symbol
  // ordering. The linked image receives ABI metadata from the Rust target.
  const copied = Bun.spawnSync([objcopy, "--remove-section=.MIPS.abiflags", "--remove-section=.gnu.attributes", output, temporary], { stdout: "inherit", stderr: "inherit" });
  if (copied.exitCode !== 0) process.exit(copied.exitCode);
  const bytes = readFileSync(temporary);
  if (bytes.length < 52 || bytes.readUInt32LE(0) !== 0x464c457f || bytes[4] !== 1 || bytes[5] !== 1)
    throw new Error("PSP compiler produced an unexpected object format");
  bytes.writeUInt32LE((bytes.readUInt32LE(36) & ~0x00ff0000) >>> 0, 36);
  writeFileSync(temporary, bytes);
  renameSync(temporary, output);
}
