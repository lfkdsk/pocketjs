import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  createRelayFrameReplay,
  parseFrameTape,
  RelayFrameRecorder,
  sha256Hex,
  stringifyFrameTape,
  verifyFrameTape,
  wrapRelayTransport,
  type RelayFrameDirection,
} from "../framework/src/relay/tape.ts";
import { decodeFrame } from "../framework/src/relay/frame.ts";

type MutableTape = {
  kind: "relay-frame"; v: 1; session: string;
  frames: [RelayFrameDirection, number, string, string][];
};

const FIX = new URL("./fixtures/relay/", import.meta.url);

async function loadBin(name: string): Promise<Uint8Array> {
  const spec = await Bun.file(new URL(`vectors/${name}.json`, FIX)).json() as { file: string };
  return new Uint8Array(await Bun.file(new URL(spec.file, FIX)).arrayBuffer());
}

// --- step 1: sha256 -----------------------------------------------------------

test("sha256: FIPS 180-4 known-answer vectors", () => {
  expect(sha256Hex(new TextEncoder().encode("")))
    .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex(new TextEncoder().encode("abc")))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex(new TextEncoder().encode(
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
  ))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("sha256: padding block boundaries (54/55/56/63/64/65 bytes)", () => {
  // Boundaries: message ends 2 bytes short of a full block, exactly at the
  // 0x80+length threshold, and one byte each side of a full 64-byte block.
  for (const len of [54, 55, 56, 63, 64, 65, 119, 120, 127, 128]) {
    const msg = new Uint8Array(len).fill(0x61);
    expect(sha256Hex(msg)).toBe(createHash("sha256").update(msg).digest("hex"));
  }
});

test("sha256: one million 'a' bytes", () => {
  expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61)))
    .toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("sha256: 200 deterministic random buffers match node:crypto", () => {
  let seed = 0x52454c41;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 200; i++) {
    const msg = Uint8Array.from({ length: Math.floor(rnd() * 300) }, () => Math.floor(rnd() * 256));
    expect(sha256Hex(msg)).toBe(createHash("sha256").update(msg).digest("hex"));
  }
});

// --- step 2: recorder + format ------------------------------------------------

test("record a P1 vector sequence: tuples are exactly (direction, seq, frameHex, sha256)", async () => {
  const session = 0x0102030405060708n;
  const script = [
    ["ping", "out"], ["response-final", "in"], ["get", "out"], ["credit", "in"],
  ] as const;
  const rec = new RelayFrameRecorder({ session });
  for (const [name, dir] of script) {
    const bin = await loadBin(name);
    rec.note(bin, dir);
  }
  expect(rec.framesRecorded).toBe(4);
  const tape = rec.toTape();
  expect(tape.kind).toBe("relay-frame");
  expect(tape.v).toBe(1);
  expect(tape.session).toBe("0102030405060708");
  expect(Object.keys(tape).sort()).toEqual(["frames", "kind", "session", "v"]);
  expect(tape.frames.map((e) => e[0])).toEqual(["out", "in", "out", "in"]);
  expect(tape.frames.map((e) => e[1])).toEqual([3, 1, 1, 4]);
  for (const tuple of tape.frames) {
    expect(tuple).toHaveLength(4);
    const bytes = Uint8Array.from(
      tuple[2].match(/../g)!.map((h) => parseInt(h, 16)),
    );
    expect(tuple[3]).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});

test("bootstrap session 0 records as session 0000000000000000", async () => {
  const rec = new RelayFrameRecorder();
  rec.noteOut(await loadBin("hello"));
  rec.noteIn(await loadBin("hello-response"));
  expect(rec.toTape().session).toBe("0000000000000000");
});

test("a frame from another session is refused", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const hello = await loadBin("hello");
  expect(() => rec.noteIn(hello)).toThrow(/does not match tape session/);
});

test("records must be complete PRLY records", async () => {
  const rec = new RelayFrameRecorder();
  const good = await loadBin("ping");
  expect(() => rec.noteOut(good.subarray(0, 40))).toThrow(/short record/);
  const badMagic = good.slice(); badMagic[4] = 0x58;
  expect(() => rec.noteOut(badMagic)).toThrow(/PRLY/);
  const badLen = good.slice(); new DataView(badLen.buffer).setUint32(0, 999, true);
  expect(() => rec.noteOut(badLen)).toThrow(/prefix declares/);
});

test("a structurally complete seq-0 frame is not recorded", async () => {
  // seq-zero.bin is a complete PRLY record that the L1 codec rejects;
  // recording rejects it too, so a produced tape always round-trips parse.
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  const zeroSeq = await loadBin("seq-zero");
  expect(() => rec.noteOut(zeroSeq)).toThrow(/seq is 0/);
});

test("recording off by default: wrapRelayTransport returns the inner transport itself", () => {
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => null as Uint8Array | null,
  };
  // No options, and explicit false: same object identity in both cases.
  expect(wrapRelayTransport(inner)).toBe(inner);
  expect(wrapRelayTransport(inner, { enabled: false })).toBe(inner);
  const t = wrapRelayTransport(inner) as typeof inner;
  expect("relayRecorder" in t).toBe(false);
  // A recorder that exists but never observes a frame keeps zero counters.
  const rec = new RelayFrameRecorder();
  expect(rec.framesRecorded).toBe(0);
  expect(rec.bytesRecorded).toBe(0);
});

test("enabled wrapper records both directions and delegates every byte", async () => {
  const ping = await loadBin("ping");
  const credit = await loadBin("credit");
  const inbox = [credit];
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => inbox.shift() ?? null,
  };
  const t = wrapRelayTransport(inner, { enabled: true, session: 0x0102030405060708n });
  expect(t).not.toBe(inner);
  if (!("relayRecorder" in t)) throw new Error("enabled wrapper should carry a recorder");
  t.send(ping);
  expect(t.recv()).toBe(credit);
  expect(t.recv()).toBeNull();
  expect(sent).toEqual([ping]);
  expect(t.relayRecorder.framesRecorded).toBe(2);
  expect(t.relayRecorder.bytesRecorded).toBe(ping.length + credit.length);
  const tape = t.relayRecorder.toTape();
  expect(tape.frames.map((e) => e[0])).toEqual(["out", "in"]);
});

// --- step 3: parse / verify / replay ------------------------------------------

test("parseFrameTape round-trips and rejects the input tape format", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const tape = rec.toTape();
  const parsed = parseFrameTape(stringifyFrameTape(tape));
  expect(parsed).toEqual(tape);
  // Input tape v1 (tools/tape.ts writes {v, app, frames, masks}).
  expect(() => parseFrameTape(JSON.stringify({ v: 1, app: "hero-main", frames: 1, masks: [] })))
    .toThrow(/input tape/);
  // Input tape v2/v3 shape is refused the same way.
  expect(() => parseFrameTape(JSON.stringify({ v: 3, app: "x", frames: 1, masks: [], touch: [] })))
    .toThrow(/input tape/);
});

test("parseFrameTape rejects every structural deviation", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const base = rec.toTape();
  const bad = (mut: (t: unknown) => void) => {
    const t = JSON.parse(JSON.stringify(base)) as unknown;
    mut(t);
    return () => parseFrameTape(JSON.stringify(t));
  };
  expect(bad((t) => { (t as { kind: string }).kind = "input"; })).toThrow(/kind/);
  expect(bad((t) => { (t as { v: number }).v = 2; })).toThrow(/tape v/);
  expect(bad((t) => { (t as { session: string }).session = "deadbeef"; })).toThrow(/session/);
  expect(bad((t) => { (t as { frames: unknown[] }).frames = []; })).not.toThrow(); // empty is parseable
  expect(bad((t) => { (t as { frames: unknown[] }).frames = [["out", 1, "aa".repeat(48)]]; }))
    .toThrow(/4-tuple/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][0] = "up"; })).toThrow(/direction/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][1] = 0; })).toThrow(/seq/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][3] = "z".repeat(64); })).toThrow(/sha256/);
});

test("verifyFrameTape: recorded tape verifies; one tampered byte reports that tuple's seq", async () => {
  const names = ["ping", "response-final", "get", "credit"] as const;
  const dirs = ["out", "in", "out", "in"] as const;
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  for (const name of names) rec.note(await loadBin(name), dirs[names.indexOf(name)]);
  const tape = rec.toTape();
  expect(verifyFrameTape(tape).ok).toBe(true);

  // Tamper one metadata byte in tuple index 2 ("get", seq 1): length prefix
  // and header stay intact, so the divergence is digest at that exact index.
  const tampered = JSON.parse(JSON.stringify(tape)) as MutableTape;
  const frameHex = tampered.frames[2][2];
  const flipAt = 48 * 2 + 4; // first metadata byte after the 48-byte header
  const ch = frameHex[flipAt] === "0" ? "1" : "0";
  tampered.frames[2] = [tampered.frames[2][0], tampered.frames[2][1],
    frameHex.slice(0, flipAt) + ch + frameHex.slice(flipAt + 1), tampered.frames[2][3]];
  const v = verifyFrameTape(tampered);
  expect(v.ok).toBe(false);
  expect(v.frames).toBe(2);
  expect(v.divergence!.index).toBe(2);
  expect(v.divergence!.seq).toBe(tape.frames[2][1]);
  expect(v.divergence!.code).toBe("digest");
});

test("replay: P1 vector sequence replays OK in capture order", async () => {
  const names = ["ping", "response-final", "get", "credit"] as const;
  const dirs = ["out", "in", "out", "in"] as const;
  const bins = new Map<string, Uint8Array>();
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  for (const name of names) {
    const bin = await loadBin(name);
    bins.set(name, bin);
    rec.note(bin, dirs[names.indexOf(name)]);
  }
  const tape = parseFrameTape(stringifyFrameTape(rec.toTape()));
  const replay = createRelayFrameReplay(tape);

  // Drive the fake session the same way the recorded session ran: outbound
  // frames are produced, inbound frames are pulled and byte-compared.
  replay.send(bins.get("ping")!);
  const reply = replay.recv();
  expect(Buffer.compare(Buffer.from(reply!), Buffer.from(bins.get("response-final")!))).toBe(0);
  replay.send(bins.get("get")!);
  const push = replay.recv();
  expect(Buffer.compare(Buffer.from(push!), Buffer.from(bins.get("credit")!))).toBe(0);
  const verdict = replay.result();
  expect(verdict.ok, verdict.divergence?.detail).toBe(true);
  expect(replay.framesChecked).toBe(4);
  // Fed-back bytes still decode through the P1 codec.
  expect(decodeFrame(reply!, { maxWireBytes: 4096 }).ok).toBe(true);
});

test("replay: a tampered outbound frame reports the first divergent seq", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const replay = createRelayFrameReplay(parseFrameTape(stringifyFrameTape(rec.toTape())));
  const mutated = (await loadBin("ping")).slice();
  mutated[52] ^= 0x01;
  replay.send(mutated);
  const v = replay.result();
  expect(v.ok).toBe(false);
  expect(v.divergence!.index).toBe(0);
  expect(v.divergence!.seq).toBe(3); // ping seq
  expect(v.divergence!.code).toBe("digest");
  // The latch is sticky: later correct calls do not clear it.
  replay.recv();
  expect(replay.result().divergence!.seq).toBe(3);
});

test("replay: a tampered inbound record surfaces at the recv step", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const tape = rec.toTape();
  const tampered = JSON.parse(JSON.stringify(tape)) as MutableTape;
  const hex = tampered.frames[1][2];
  tampered.frames[1] = [tampered.frames[1][0], tampered.frames[1][1],
    hex.slice(0, 200) + (hex[200] === "a" ? "b" : "a") + hex.slice(201), tampered.frames[1][3]];
  const replay = createRelayFrameReplay(tampered);
  replay.send(await loadBin("ping"));
  expect(replay.recv()).toBeNull();
  const v = replay.result();
  expect(v.ok).toBe(false);
  expect(v.divergence!.index).toBe(1);
  expect(v.divergence!.seq).toBe(4); // credit seq
});

test("replay: wrong direction, extra frame, and early stop each report their code", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const make = () => createRelayFrameReplay(parseFrameTape(stringifyFrameTape(rec.toTape())));

  // recv() at an outbound entry is a non-blocking poll: null, no divergence.
  // Sending at an inbound entry latches the direction error at that index.
  let replay = make();
  expect(replay.recv()).toBeNull();
  replay.send(await loadBin("ping")); // consumes entry 0 (out)
  replay.send(await loadBin("ping")); // entry 1 is inbound → direction
  const d = replay.result().divergence!;
  expect(d.code).toBe("direction");
  expect(d.index).toBe(1);
  expect(d.seq).toBe(4); // credit seq

  // Clean run plus one extra send → unexpected at end.
  replay = make();
  replay.send(await loadBin("ping"));
  replay.recv();
  replay.send(await loadBin("ping"));
  expect(replay.result().divergence!.code).toBe("unexpected");

  // Stop after the first frame → incomplete naming the remaining tuple.
  replay = make();
  replay.send(await loadBin("ping"));
  const v = replay.result();
  expect(v.divergence!.code).toBe("incomplete");
  expect(v.divergence!.index).toBe(1);
});

test("benchmark: record + serialize 10,000 frames", async () => {
  const ping = await loadBin("ping");
  const rec = new RelayFrameRecorder();
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) rec.note(ping, i % 2 === 0 ? "out" : "in");
  const text = stringifyFrameTape(rec.toTape());
  const ms = performance.now() - start;
  console.log(
    `relay record+serialize 10000 frames: ${ms.toFixed(1)} ms `
      + `(${(ms / 10_000 * 1000).toFixed(2)} µs/frame), file ${text.length} bytes `
      + `(${(text.length / 10_000).toFixed(1)} B/frame, ${rec.bytesRecorded} wire bytes)`,
  );
  expect(rec.framesRecorded).toBe(10_000);
  expect(parseFrameTape(text).frames).toHaveLength(10_000);
  expect(ms).toBeLessThan(5000);
});
