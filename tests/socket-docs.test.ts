import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

/** `fn …;` and `pub field: type,` lines of one Rust item, whitespace-collapsed. */
function members(source: string, header: string): string[] {
  const start = source.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf("\n}", start));
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("fn ") || line.startsWith("pub "))
    .filter((line) => line !== header.trim())
    .map((line) => line.replace(/std::result::Result/g, "Result").replace(/\s+/g, " "));
}

test("SOCKET.md publishes the SocketTransport boundary the core implements", () => {
  const core = read("engine/crates/pocket-socket/src/lib.rs");
  const docs = read("docs/SOCKET.md").replace(/\s+/g, " ");
  const signatures = members(core, "pub trait SocketTransport {");
  expect(signatures.length).toBe(5);
  for (const signature of signatures) expect(docs).toContain(signature);
  for (const field of members(core, "pub struct Sent {")) {
    expect(docs).toContain(field.replace(/,$/, ""));
  }
  // The per-message overhead is released by message count.
  expect(docs).toContain("bytes + 64 × messages");
});
