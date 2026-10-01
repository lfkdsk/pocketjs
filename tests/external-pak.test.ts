import { afterEach, expect, test } from "bun:test";
import { pack } from "../framework/compiler/pak.ts";
import { dtypeOf, entries, get, loadPack, resetPack } from "../framework/src/pak.ts";
const globals = globalThis as typeof globalThis & { __pakRead?: (key: string, start: number, end: number) => ArrayBuffer | undefined };
const exactBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
afterEach(() => { delete globals.__pakRead; resetPack(); });
test("a split pack preserves enumeration, dtype, copy and bounded-read contracts", () => {
  const full = pack([{ key: "data", dtype: 3, data: new Uint8Array([1, 2, 3, 4]) }]);
  const offset = new DataView(full.buffer, full.byteOffset, full.byteLength).getUint32(20, true);
  const boot = pack([{ key: "pocket:external-index", dtype: 0, data: full.slice(0, offset) }]);
  const calls: number[][] = [];
  globals.__pakRead = (key, start, end) => { expect(key).toBe("data"); calls.push([start, end]); return new Uint8Array([1, 2, 3, 4]).slice(start, end).buffer; };
  loadPack(exactBuffer(boot));
  expect(entries("data")).toEqual(["data"]);
  expect(dtypeOf("data")).toBe(3);
  expect([...get("data", 1, 3)]).toEqual([2, 3]);
  const copy = get("data"); copy[0] = 9;
  expect([...get("data")]).toEqual([1, 2, 3, 4]);
  for (const [start, end] of [[-1, 2], [0.5, 2], [2, 1], [0, 5]]) expect(() => get("data", start, end)).toThrow(RangeError);
  expect(calls).toEqual([[1, 3], [0, 4], [0, 4]]);
  globals.__pakRead = () => undefined;
  expect(() => get("data")).toThrow(/external read failed/);
});

test("external entries require a reader and never replace embedded entries", () => {
  const full = pack([
    { key: "external", dtype: 1, data: new Uint8Array([8]) },
    { key: "shared", dtype: 1, data: new Uint8Array([9]) },
  ]);
  const offset = new DataView(full.buffer, full.byteOffset, full.byteLength).getUint32(20, true);
  const boot = pack([
    { key: "pocket:external-index", dtype: 0, data: full.slice(0, offset) },
    { key: "shared", dtype: 2, data: new Uint8Array([7]) },
  ]);
  const bytes = exactBuffer(boot);
  loadPack(bytes);
  expect(entries()).toEqual(["pocket:external-index", "shared"]);

  globals.__pakRead = (_key, start, end) => new Uint8Array(end - start).fill(8).buffer;
  loadPack(bytes);
  expect(entries("external")).toEqual(["external"]);
  expect(dtypeOf("shared")).toBe(2);
  expect([...get("shared")]).toEqual([7]);
  expect([...get("external", 0, 0)]).toEqual([]);
  globals.__pakRead = () => new ArrayBuffer(0);
  expect(() => get("external")).toThrow(/external read failed/);
});

test("a malformed external directory is rejected before enumeration", () => {
  const full = pack([{ key: "data", dtype: 3, data: new Uint8Array([1]) }]);
  const offset = new DataView(full.buffer, full.byteOffset, full.byteLength).getUint32(20, true);
  const index = full.slice(0, offset);
  new DataView(index.buffer, index.byteOffset, index.byteLength).setUint32(12, index.length - 1, true);
  const boot = pack([{ key: "pocket:external-index", dtype: 0, data: index }]);
  globals.__pakRead = () => new ArrayBuffer(0);
  expect(() => loadPack(exactBuffer(boot))).toThrow(/invalid external index/);
});
