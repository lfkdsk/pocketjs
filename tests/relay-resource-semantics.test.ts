import { expect, test } from "bun:test";
import {
  RELAY_CODEC, RELAY_DELIVERY, RELAY_ERROR, RELAY_KIND, RELAY_TYPE,
  type RelayProfileEntry, type RelayResourceRef, type RelayRxLimits,
} from "../contracts/spec/relay.ts";
import {
  RelayEndpoint, type RelayResourceForm,
} from "../framework/src/relay/endpoint.ts";
import { decodeFrame, encodeFrame, type RelayDecodedFrame } from "../framework/src/relay/frame.ts";
import type { RelayLocalCapabilities, RelayScheduler } from "../framework/src/relay/session.ts";
import type { ResourceResult } from "../framework/src/resource-cache.ts";

const PROFILE: RelayProfileEntry = { name: "term.grid", version: 1 };
const RX: RelayRxLimits = {
  maxWireBytes: 4096, maxMetaBytes: 2048, windowFrames: 8, windowBytes: 32768,
  maxPending: 8, maxObjectBytes: 131072, maxAssemblies: 4, maxScratchBytes: 524288,
};
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", additionalProperties: false, properties, required }) as const;
const FORM: RelayResourceForm = {
  profile: PROFILE, kind: RELAY_KIND.TERMINAL_CELLS, argsKey: "term",
  args: closed({ page: { type: "integer", minimum: 0 } }),
  value: closed({
    lines: { type: "array", items: { type: "string" } },
    cursor: { type: "integer", minimum: 0 },
  }),
  onSubscribe: true,
};
const resourceRef = (revision = "s-42"): RelayResourceRef => ({
  kind: RELAY_KIND.TERMINAL_CELLS, ns: "term/session-1", key: "scrollback", revision,
  rendition: "grid-density1-v1",
});
const page = (cursor: number) => ({ lines: [`line-${cursor}`], cursor });
type Role = "guest" | "provider";

const scheduler = (): RelayScheduler => {
  let id = 0;
  return { now: () => 0, setTimeout: () => ++id, clearTimeout: () => {} };
};
const capabilities = (): RelayLocalCapabilities => ({
  app: "example", versions: [[1, 0]], profiles: [PROFILE],
  codecs: [RELAY_CODEC.NONE, RELAY_CODEC.JSON],
  kinds: [RELAY_KIND.TERMINAL_CELLS, RELAY_KIND.FILE], rxLimits: RX,
});

function pair(transform?: (from: Role, frame: RelayDecodedFrame) => RelayDecodedFrame) {
  const endpoints = {} as Record<Role, RelayEndpoint>;
  const route = (from: Role, bytes: Uint8Array<ArrayBufferLike>) => {
    let copy: Uint8Array<ArrayBufferLike> = bytes.slice();
    if (transform) {
      const decoded = decodeFrame(copy);
      if (!decoded.ok) throw new Error(decoded.code);
      const encoded = encodeFrame(transform(from, decoded.frame));
      if (!encoded.ok) throw new Error(encoded.code);
      copy = encoded.bytes;
    }
    endpoints[from === "guest" ? "provider" : "guest"].handleRecord(copy);
    return "accepted" as const;
  };
  for (const role of ["guest", "provider"] as const) {
    endpoints[role] = new RelayEndpoint({
      role, local: capabilities(), resourceForms: [FORM],
      transport: { peer: { id: `peer-${role}`, grants: ["example"] }, trySend: bytes => route(role, bytes) },
      scheduler: scheduler(), randomBytes: n => new Uint8Array(n).fill(role === "guest" ? 17 : 23),
    });
  }
  const settle = async () => {
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
      endpoints.guest.flush();
      endpoints.provider.flush();
    }
  };
  return { ...endpoints, settle };
}

async function connect(link: ReturnType<typeof pair>): Promise<number> {
  expect(link.guest.hello()).toEqual({ ok: true });
  await link.settle();
  await link.guest.whenReady();
  const opened = link.guest.open({ app: "example", namespace: "term/session-1", profile: PROFILE });
  await link.settle();
  return (await opened).stream;
}

async function subscribe(
  link: ReturnType<typeof pair>, stream: number, target: RelayResourceRef | { ns: string },
  objects: unknown[], ends: string[],
): Promise<number> {
  const result = await new Promise<ResourceResult<{ subscription?: number }>>(resolve => {
    const started = link.guest.subscribe(stream, target, RELAY_DELIVERY.LATEST_SNAPSHOT, {
      onObject: object => objects.push(object),
      onEnd: error => ends.push(error?.code ?? "closed"),
    }, resolve, "kind" in target ? { product: { key: "term", value: { page: 1 } } } : undefined);
    if (!("correlation" in started)) resolve({ ok: false, error: { code: started.code } });
  });
  await link.settle();
  expect(result.ok).toBe(true);
  if (!result.ok || !("value" in result) || result.value.subscription === undefined) {
    throw new Error("subscribe failed");
  }
  return result.value.subscription;
}

test("ref subscription push filter is enforced by provider and consumer while revision advances", async () => {
  const mutations: Array<[string, (ref: RelayResourceRef) => RelayResourceRef]> = [
    ["namespace", ref => ({ ...ref, ns: "term/other" })],
    ["kind", ref => ({ ...ref, kind: RELAY_KIND.FILE })],
    ["key", ref => ({ ...ref, key: "other" })],
    ["rendition", ref => ({ ...ref, rendition: "other-v1" })],
  ];

  for (const [field, mutate] of mutations) {
    let wireMutation: ((ref: RelayResourceRef) => RelayResourceRef) | undefined;
    const link = pair((from, frame) => {
      if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !wireMutation) return frame;
      return { ...frame, metadata: { ...frame.metadata,
        resource: wireMutation(frame.metadata.resource as RelayResourceRef),
      } };
    });
    const objects: unknown[] = [];
    const ends: string[] = [];
    const stream = await connect(link);
    const id = await subscribe(link, stream, resourceRef(), objects, ends);

    const local = link.provider.pushObject({
      stream, subscription: id, ref: mutate(resourceRef("s-43")),
      codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(1),
    });
    expect(local, `provider ${field}`).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
    expect(link.guest.client!.subscription(id)).toBeDefined();

    wireMutation = mutate;
    const sent = link.provider.pushObject({
      stream, subscription: id, ref: resourceRef("s-43"),
      codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(2),
    });
    expect(sent, `consumer ${field}`).toEqual({ ok: true, frames: 1 });
    await link.settle();
    expect(objects, `consumer ${field}`).toEqual([]);
    expect(ends, `consumer ${field}`).toEqual([RELAY_ERROR.INVALID]);
    expect(link.guest.client!.subscription(id)).toBeUndefined();
  }

  const positive = pair();
  const objects: Array<{ ref: RelayResourceRef }> = [];
  const ends: string[] = [];
  const stream = await connect(positive);
  const id = await subscribe(positive, stream, resourceRef(), objects, ends);
  expect(positive.provider.pushObject({
    stream, subscription: id, ref: resourceRef("s-43"),
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: page(3),
  })).toEqual({ ok: true, frames: 1 });
  await positive.settle();
  expect(objects.map(object => object.ref.revision)).toEqual(["s-43"]);
  expect(ends).toEqual([]);
});

test("namespace subscription filters only namespace on provider and consumer", async () => {
  let corruptNamespace = false;
  const link = pair((from, frame) => {
    if (from !== "provider" || frame.type !== RELAY_TYPE.PUSH || !corruptNamespace) return frame;
    return { ...frame, metadata: { ...frame.metadata,
      resource: { ...(frame.metadata.resource as RelayResourceRef), ns: "term/other" },
    } };
  });
  const objects: Array<{ ref: RelayResourceRef }> = [];
  const ends: string[] = [];
  const stream = await connect(link);
  const id = await subscribe(link, stream, { ns: "term/session-1" }, objects, ends);
  const fileRef: RelayResourceRef = {
    kind: RELAY_KIND.FILE, ns: "term/session-1", key: "font", revision: "f-1", rendition: "font3",
  };

  expect(link.provider.pushObject({
    stream, subscription: id, ref: fileRef, codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 19 },
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects.map(object => object.ref)).toEqual([fileRef]);

  expect(link.provider.pushObject({
    stream, subscription: id, ref: { ...fileRef, ns: "term/other" },
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 20 },
  })).toEqual({ ok: false, code: RELAY_ERROR.INVALID });
  expect(link.guest.client!.subscription(id)).toBeDefined();

  corruptNamespace = true;
  expect(link.provider.pushObject({
    stream, subscription: id, ref: { ...fileRef, revision: "f-2" },
    codec: RELAY_CODEC.NONE, data: new Uint8Array(), value: { slot: 21 },
  })).toEqual({ ok: true, frames: 1 });
  await link.settle();
  expect(objects).toHaveLength(1);
  expect(ends).toEqual([RELAY_ERROR.INVALID]);
  expect(link.guest.client!.subscription(id)).toBeUndefined();
});
