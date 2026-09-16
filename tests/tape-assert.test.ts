// tests/tape-assert.test.ts — fail-closed schema validation for tape golden
// `--assert` files. Review B2r found that a missing/null `hashes` field turned
// the assertion off and an array-like object {0: h0, length: 180} checked only
// frame 0 yet still printed "180 frames match"; every malformed, partial, or
// mismatched golden must name the defect and reject before booting instead.
//
// The end-to-end 180/180 replay is the "tape golden" stage in tools/test.ts
// (it needs hosts/web/pocketjs.wasm); this file covers the validator itself
// and the CLI's fail-closed path, which rejects before any build.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAssertHashes } from "../tools/tape.ts";

const APP = "hero-main";
const FRAMES = 180;
const golden = JSON.parse(
  readFileSync(new URL("./tapes/hero-main.hashes.json", import.meta.url), "utf8"),
) as { app: string; frames: number; hashes: string[] };

function validDoc(): { app: string; frames: number; hashes: unknown[] } {
  return { app: APP, frames: FRAMES, hashes: [...golden.hashes] };
}

function reject(doc: unknown, fragment: RegExp): void {
  expect(() => parseAssertHashes(doc, "golden.json", APP, FRAMES)).toThrow(fragment);
}

describe("tape --assert schema (pure validator)", () => {
  test("the committed golden is valid and returns its 180 hashes in order", () => {
    const hashes = parseAssertHashes(golden, "tests/tapes/hero-main.hashes.json", APP, FRAMES);
    expect(hashes).toHaveLength(180);
    expect(hashes).toEqual(golden.hashes);
    expect(hashes[0]).toBe("78bb9ae7");
    expect(hashes[179]).toBe("68ddb0f3");
  });

  test("a small well-formed document validates", () => {
    const doc = { app: "demo", frames: 2, hashes: ["01234567", "89abcdef"] };
    expect(parseAssertHashes(doc, "small.json", "demo", 2)).toEqual(["01234567", "89abcdef"]);
  });

  test("root must be an object", () => {
    reject(null, /root must be an object/);
    reject([], /root must be an object/);
    reject("golden", /root must be an object/);
    reject(180, /root must be an object/);
    reject(true, /root must be an object/);
  });

  test("app must be a string matching the replayed app", () => {
    let doc = validDoc();
    delete (doc as Partial<typeof doc>).app;
    reject(doc, /"app"/);
    doc = { ...validDoc(), app: 42 };
    reject(doc, /"app"/);
    doc = { ...validDoc(), app: "wrong-app" };
    reject(doc, /wrong-app/);
  });

  test("frames must be a non-negative integer agreeing with the array", () => {
    let doc = validDoc();
    delete (doc as Partial<typeof doc>).frames;
    reject(doc, /"frames"/);
    reject({ ...validDoc(), frames: "180" }, /"frames"/);
    reject({ ...validDoc(), frames: 17.5 }, /"frames"/);
    reject({ ...validDoc(), frames: -1 }, /"frames"/);
    reject({ ...validDoc(), frames: 17 }, /"frames" is 17/);
  });

  test("hashes must be present (missing or null must not disable the assert)", () => {
    const doc = validDoc() as Partial<ReturnType<typeof validDoc>>;
    delete doc.hashes;
    reject(doc, /missing field "hashes"/);
    reject({ app: APP, frames: FRAMES, hashes: null }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: undefined }, /"hashes" must be an array/);
  });

  test("hashes must be a real array (objects cannot masquerade as one)", () => {
    const fake = { "0": golden.hashes[0], length: 180 };
    reject({ app: APP, frames: FRAMES, hashes: fake }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: golden.hashes.join("") }, /"hashes" must be an array/);
    reject({ app: APP, frames: FRAMES, hashes: 180 }, /"hashes" must be an array/);
  });

  test("length must match the frames the tape replays", () => {
    reject({ ...validDoc(), frames: 179, hashes: golden.hashes.slice(0, 179) }, /hashes length 179/);
    reject({ ...validDoc(), frames: 181, hashes: [...golden.hashes, "deadbeef"] }, /hashes length 181/);
    reject({ app: APP, frames: 0, hashes: [] }, /hashes length 0/);
  });

  test("hashes must be dense: holes are rejected at their index", () => {
    const sparse: unknown[] = new Array(3);
    sparse[0] = "01234567";
    sparse[2] = "89abcdef";
    expect(() => parseAssertHashes({ app: "demo", frames: 3, hashes: sparse }, "golden.json", "demo", 3)).toThrow(
      /sparse.*index 1/,
    );
  });

  test("every entry must be an 8-char lowercase hex string", () => {
    const variants: { h: unknown; at: number }[] = [
      { h: 12345678, at: 0 },
      { h: null, at: 1 },
      { h: { hex: "78bb9ae7" }, at: 2 },
      { h: "78BB9AE7", at: 3 }, // uppercase not produced by the hasher
      { h: "78bb9ae", at: 4 }, // 7 chars
      { h: "78bb9ae77", at: 5 }, // 9 chars
      { h: "zzzzzzzz", at: 6 }, // non-hex
      { h: "", at: 7 },
    ];
    for (const { h, at } of variants) {
      const hashes = golden.hashes.slice();
      hashes[at] = h as string;
      reject({ app: APP, frames: FRAMES, hashes }, new RegExp(`hashes\\[${at}\\]`));
    }
  });

  test("frame count argument disagreements are rejected too", () => {
    // The tape expands to 180 frames; a golden claiming 181 while the array is
    // internally consistent must not match.
    expect(() => parseAssertHashes({ ...validDoc(), frames: 180 }, "g.json", APP, 181)).toThrow(
      /hashes length 180 .* 181 frames/,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI fail-closed behaviour — every malformed golden exits non-zero BEFORE the
// bundle boots (no "tape: rebuilding" line) and never prints a match.
// ---------------------------------------------------------------------------

const root = new URL("..", import.meta.url).pathname;
const tmpDirs: string[] = [];

function tmp(): string {
  const dir = `/tmp/pocketjs-tape-assert-${process.pid}-${Math.random().toString(16).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runTapeCli(assertPath: string) {
  return Bun.spawnSync(
    [
      process.execPath,
      "tools/tape.ts",
      "replay",
      "hero-main",
      "tests/tapes/hero-main.tape.json",
      "--assert",
      assertPath,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
}

describe("tape replay --assert CLI fails closed", () => {
  const cases: { name: string; body: (dir: string) => string; error: RegExp }[] = [
    {
      name: "hashes null — assertion must not switch off",
      body: (d) => {
        const p = join(d, "null.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes: null }));
        return p;
      },
      error: /"hashes" must be an array/,
    },
    {
      name: "hashes missing — assertion must not switch off",
      body: (d) => {
        const p = join(d, "missing.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES }));
        return p;
      },
      error: /missing field "hashes"/,
    },
    {
      name: "array-like object must not partially assert frame 0",
      body: (d) => {
        const p = join(d, "objectfake.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes: { "0": golden.hashes[0], length: 180 } }));
        return p;
      },
      error: /"hashes" must be an array/,
    },
    {
      name: "wrong app metadata is rejected",
      body: (d) => {
        const p = join(d, "metadata.json");
        writeFileSync(p, JSON.stringify({ app: "wrong-app", frames: 17, hashes: golden.hashes }));
        return p;
      },
      error: /wrong-app/,
    },
    {
      name: "179-entry partial array is rejected before replay",
      body: (d) => {
        const p = join(d, "short.json");
        writeFileSync(p, JSON.stringify({ app: APP, frames: 179, hashes: golden.hashes.slice(0, 179) }));
        return p;
      },
      error: /hashes length 179/,
    },
    {
      name: "illegal element is rejected with its index",
      body: (d) => {
        const p = join(d, "bad-entry.json");
        const hashes = golden.hashes.slice();
        hashes[5] = "DEADBEEF";
        writeFileSync(p, JSON.stringify({ app: APP, frames: FRAMES, hashes }));
        return p;
      },
      error: /hashes\[5\]/,
    },
    {
      name: "syntactically invalid JSON is reported explicitly",
      body: (d) => {
        const p = join(d, "broken.json");
        writeFileSync(p, '{ "hashes": [ ');
        return p;
      },
      error: /invalid JSON/,
    },
    {
      name: "missing assert file is reported explicitly",
      body: (d) => join(d, "does-not-exist.json"),
      error: /cannot read --assert/,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const assertPath = c.body(tmp());
      const result = runTapeCli(assertPath);
      const out = result.stdout.toString();
      const err = result.stderr.toString();
      expect(result.exitCode, err + out).not.toBe(0);
      expect(err).toMatch(c.error);
      expect(out).not.toMatch(/frames match/);
      // Rejection happens before boot: the app bundle is never built.
      expect(out + err).not.toMatch(/rebuilding|missing — running/);
    }, 10_000);
  }
});
