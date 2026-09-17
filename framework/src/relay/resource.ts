/** Relay L2 resource layer — identity, get/subscribe/release, invalidation,
 * chunked atomic publication and residence budget (R5 draft §3.5–§3.8).
 *
 * Both ends are transport-neutral state machines. The L1 session layer
 * (HELLO/OPEN/seq/correlation/credit) sits below `RelayResourceWire`; L2
 * never assigns a session or a wire seq. Frames cross the seam as metadata
 * plus an optional data region:
 *
 *   RelayResourceClient    (guest/consumer): get, subscribe, unsubscribe,
 *     release, reportEvict; receives RESPONSE/PUSH/INVALIDATE.
 *   RelayResourceAuthority (companion/provider): validates requests,
 *     allocates subscription/lease/transfer ids (never reused), chunks
 *     outbound objects, emits scoped invalidation.
 *
 * Publication invariants: a chunked object reaches a subscriber or the local
 * entry once, after the complete object passes its digest check at a frame
 * boundary. A half object is never visible. Invalidation advances a local
 * generation; late responses stamped with an older generation are dropped. */

import {
  RELAY_CODEC,
  RELAY_DELIVERY,
  RELAY_ERROR,
  RELAY_EVICT_REASON,
  RELAY_INVALIDATE_SCOPE,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayErrorBody,
  type RelayResourceRef,
} from "../../../contracts/spec/relay.ts";
import type { ResourceLoad, ResourceResult } from "../resource-cache.ts";
import { stringToUtf8 } from "../bytes.ts";
import { RelayChunkAssembler } from "./assembler.ts";
import type { RelayResourceErrorCode } from "./assembler.ts";
import { sha256Hex } from "./sha256.ts";
import { validateRelayMetadata } from "./metadata.ts";

export { RELAY_DELIVERY, RELAY_INVALIDATE_SCOPE, RELAY_EVICT_REASON };

const hex16 = (n: number): string => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffffffffffff) throw new Error("offset out of u64");
  return n.toString(16).padStart(16, "0");
};

// --- identity ----------------------------------------------------------------

/** Cache identity per §3.5: (ns, kind, key, revision, rendition). The
 * authenticated authority is the pinned session/namespace grant and is not
 * repeated here. */
export function relayResourceKey(ref: RelayResourceRef): string {
  return `${ref.kind}|${ref.ns}|${ref.key}|${ref.revision ?? ""}|${ref.rendition}`;
}

function refMatchesKeyScope(a: RelayResourceRef, b: RelayResourceRef): boolean {
  return a.kind === b.kind && a.ns === b.ns && a.key === b.key && a.rendition === b.rendition;
}

/** Session-scoped u32 allocator. Ids start at 1 and are never reused; after
 * 0xffffffff the allocator refuses instead of wrapping (§3.3/§3.6). */
export class RelayIdAllocator {
  private next = 1;
  allocate(): number {
    if (this.next > 0xffffffff) throw new Error("RELAY id space exhausted; reopen the stream or session");
    return this.next++;
  }
  allocated(): number {
    return this.next - 1;
  }
}

// --- frame seam --------------------------------------------------------------

/** What L1 must provide. request() returns the correlation it allocated, or
 * 0 when the bounded request window is full. */
export interface RelayResourceWire {
  request(stream: number, metadata: Record<string, unknown>, data?: Uint8Array): number;
  /** Send a correlation-less INVALIDATE-type advisory (cache.evict). */
  advise(metadata: Record<string, unknown>): void;
  /** request.cancel on stream 0; the terminal RESPONSE still arrives on the
   * original business stream. */
  cancel(stream: number, correlation: number, reason?: string): void;
}

/** Decoded frame shape the session pump hands to handleFrame(). */
export interface RelayResourceIncomingFrame {
  type: number;
  codec: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  data: Uint8Array;
}

export interface RelayResourceNegotiated {
  /** rxLimits.maxObjectBytes: largest assembled object this receiver reserves. */
  maxObjectBytes: number;
  codecs: readonly number[];
}

export interface RelayPublishedObject {
  ref: RelayResourceRef;
  codec: number;
  data: Uint8Array;
  value?: unknown;
  digest?: string;
}

export interface RelayResourceError {
  code: string;
  message?: string;
}

export type RelayGetOutcome =
  | { notModified: true; revision: string }
  | RelayPublishedObject;

// --- consumer ----------------------------------------------------------------

interface PendingGet {
  kind: "get";
  stream: number;
  ref: RelayResourceRef;
  /** Local identity generation captured at request time; a response stamped
   * with an older generation is dropped after invalidation. */
  generation: number;
  /** Assembler reservation exists for this correlation. */
  reserved: boolean;
  complete: (result: ResourceResult<RelayGetOutcome>) => void;
}

interface PendingControl {
  kind: "subscribe" | "unsubscribe" | "release";
  stream: number;
  complete: (result: ResourceResult<{ subscription?: number }>) => void;
}

type Pending = PendingGet | PendingControl;

export interface RelaySubscriptionHandler {
  /** One complete, in-order object. Reliable deltas arrive chained by
   * baseRevision; a broken chain sets resyncRequired. */
  onObject(object: RelayPublishedObject, ctx: { resyncRequired: boolean }): void;
  /** The subscription failed terminally (error, reset) or was closed. */
  onEnd?(error?: RelayResourceError): void;
}

export interface RelaySubscriptionEntry {
  id: number;
  stream: number;
  delivery: string;
  filter: { ns: string; kind?: number; key?: string; rendition?: string };
  revision: string | undefined;
  resyncRequired: boolean;
  handler: RelaySubscriptionHandler;
}

export interface RelayLocalEntry {
  ref: RelayResourceRef;
  revision: string;
  generation: number;
  stale: boolean;
}

export class RelayResourceClient {
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<number, RelaySubscriptionEntry>();
  private readonly entries = new Map<string, RelayLocalEntry>();
  /** Monotonic per-identity invalidation generations. Outlives the entry
   * itself: a revision-scope invalidation deletes the entry but a late
   * response must still observe the moved generation. */
  private readonly generations = new Map<string, number>();
  private readonly assembler: RelayChunkAssembler;
  private protocolErrors = 0;

  constructor(private readonly opts: {
    wire: RelayResourceWire;
    negotiated: RelayResourceNegotiated;
    assembler: RelayChunkAssembler;
  }) {
    this.assembler = opts.assembler;
  }

  /** resource.get. A conditional fetch with ifRevision may return
   * notModified, which still names the concrete revision. */
  get(
    stream: number,
    ref: RelayResourceRef,
    args: { accept: number[]; maxObjectBytes: number; ifRevision?: string },
    complete: PendingGet["complete"],
  ): { correlation: number } | { ok: false; code: string } {
    if (!args.accept.length
      || !args.accept.every((c) => Number.isInteger(c) && c >= 0 && c <= 0xffff && this.opts.negotiated.codecs.includes(c))) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    if (!Number.isSafeInteger(args.maxObjectBytes) || args.maxObjectBytes <= 0
      || args.maxObjectBytes > this.opts.negotiated.maxObjectBytes) {
      return { ok: false, code: RELAY_ERROR.TOO_LARGE };
    }
    // Reserve-then-accept: refuse (BUSY) before consuming a request slot
    // when the local assembly budget cannot hold the authorized ceiling.
    if (!this.assembler.canReserve(args.maxObjectBytes)) return { ok: false, code: RELAY_ERROR.BUSY };
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.RESOURCE_GET,
      resource: ref,
      args: { accept: [...args.accept], maxObjectBytes: args.maxObjectBytes },
    };
    if (args.ifRevision) (metadata.args as Record<string, unknown>).ifRevision = args.ifRevision;
    const correlation = this.opts.wire.request(stream, metadata);
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    // The capacity was pre-checked; reserve the concrete correlation.
    const reservation = this.assembler.reserve({ stream, channel: correlation }, args.maxObjectBytes);
    if (!reservation.ok) return { ok: false, code: reservation.code };
    this.pending.set(correlation, {
      kind: "get", stream, ref, generation: this.generationFor(ref), reserved: true, complete,
    });
    return { correlation };
  }

  /** Withdraw interest in an in-flight get. The provider still emits one
   * terminal response; the request slot frees only after it is consumed
   * (§3.9). */
  cancel(correlation: number, reason = "cancel"): void {
    const pending = this.pending.get(correlation);
    if (pending) this.opts.wire.cancel(pending.stream, correlation, reason);
  }

  /** resource.subscribe. The concrete subscription id arrives in the
   * terminal response and is never reused. */
  subscribe(
    stream: number,
    target: RelayResourceRef | { ns: string },
    delivery: string,
    handler: RelaySubscriptionHandler,
    complete: PendingControl["complete"],
  ): { correlation: number } | { ok: false; code: string } {
    if (delivery !== RELAY_DELIVERY.RELIABLE_DELTA && delivery !== RELAY_DELIVERY.LATEST_SNAPSHOT) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    const isRef = "kind" in target;
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.RESOURCE_SUBSCRIBE,
      args: isRef ? { delivery } : { delivery, namespace: (target as { ns: string }).ns },
    };
    if (isRef) metadata.resource = target;
    const correlation = this.opts.wire.request(stream, metadata);
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, {
      kind: "subscribe", stream,
      complete: (result) => {
        if (result.ok && typeof result.value.subscription === "number") {
          const id = result.value.subscription;
          // The push channel reserves one object slot for the negotiated
          // ceiling; admission failure closes the subscription.
          const reservation = this.assembler.reserve({ stream, channel: id }, this.opts.negotiated.maxObjectBytes);
          if (!reservation.ok) { handler.onEnd?.({ code: reservation.code }); complete(result); return; }
          if (isRef) {
            const ref = target as RelayResourceRef;
            this.subscriptions.set(id, {
              id, stream, delivery,
              filter: { ns: ref.ns, kind: ref.kind, key: ref.key, rendition: ref.rendition },
              revision: ref.revision, resyncRequired: false, handler,
            });
          } else {
            this.subscriptions.set(id, {
              id, stream, delivery,
              filter: { ns: (target as { ns: string }).ns },
              revision: undefined, resyncRequired: false, handler,
            });
          }
        }
        complete(result);
      },
    });
    return { correlation };
  }

  /** resource.unsubscribe. Queued pushes already on the wire are consumed
   * and dropped after the terminal response. */
  unsubscribe(
    subscription: number,
    complete: PendingControl["complete"] = () => {},
  ): { correlation: number } | { ok: false; code: string } {
    const sub = this.subscriptions.get(subscription);
    if (!sub) return { ok: false, code: RELAY_ERROR.NOT_FOUND };
    const correlation = this.opts.wire.request(sub.stream, {
      op: RELAY_OP.RESOURCE_UNSUBSCRIBE,
      args: { subscription },
    });
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, {
      kind: "unsubscribe", stream: sub.stream,
      complete: (result) => {
        if (result.ok) this.closeSubscription(subscription);
        complete(result);
      },
    });
    return { correlation };
  }

  /** resource.release — only for an explicit provider lease on remote
   * residence. Local cache eviction uses reportEvict. */
  release(
    stream: number,
    ref: RelayResourceRef,
    lease: number,
    complete: PendingControl["complete"] = () => {},
  ): { correlation: number } | { ok: false; code: string } {
    if (!Number.isInteger(lease) || lease === 0) return { ok: false, code: RELAY_ERROR.INVALID };
    const correlation = this.opts.wire.request(stream, {
      op: RELAY_OP.RESOURCE_RELEASE, resource: ref, args: { lease },
    });
    if (correlation === 0) return { ok: false, code: RELAY_ERROR.BUSY };
    this.pending.set(correlation, { kind: "release", stream, complete });
    return { correlation };
  }

  /** Dispose a local copy and advise the provider with cache.evict. The
   * advise is fire-and-forget: it requires no ACK and the provider may
   * ignore it (R5 Q5). Local disposal happens whether or not the wire
   * accepts the frame. */
  reportEvict(ref: RelayResourceRef, reason: string): void {
    if (reason !== RELAY_EVICT_REASON.BUDGET && reason !== RELAY_EVICT_REASON.VIEW_CLOSE) return;
    this.entries.delete(relayResourceKey(ref));
    this.opts.wire.advise({ op: RELAY_OP.CACHE_EVICT, resource: ref, args: { reason } });
  }

  /** INVALIDATE received from the authority. Session pumps may also call
   * this directly after classifying the frame. */
  applyInvalidate(meta: Record<string, unknown>): void {
    if (validateRelayMetadata(RELAY_OP.RESOURCE_INVALIDATE, meta)) { this.protocolErrors++; return; }
    const args = meta.args as { scope: string; namespace?: string; reason?: string };
    const ref = meta.resource as RelayResourceRef | undefined;
    const ns = ref?.ns ?? args.namespace!;

    for (const [key, entry] of this.entries) {
      const match =
        args.scope === RELAY_INVALIDATE_SCOPE.NAMESPACE ? entry.ref.ns === ns
        : ref && args.scope === RELAY_INVALIDATE_SCOPE.KEY ? refMatchesKeyScope(entry.ref, ref)
        : ref ? relayResourceKey(entry.ref) === relayResourceKey(ref) : false;
      if (!match) continue;
      const next = entry.generation + 1;
      this.generations.set(relayResourceKey(entry.ref), next);
      entry.generation = next;
      entry.stale = true;
      if (args.scope === RELAY_INVALIDATE_SCOPE.REVISION) this.entries.delete(key);
    }
    // Namespace/key scope can match identities with no resident entry but an
    // in-flight get; move their generation fence too.
    if (args.scope === RELAY_INVALIDATE_SCOPE.NAMESPACE) {
      for (const pending of this.pending.values()) {
        if (pending.kind === "get" && pending.ref.ns === ns) {
          const idKey = relayResourceKey(pending.ref);
          this.generations.set(idKey, (this.generations.get(idKey) ?? 0) + 1);
        }
      }
    } else if (ref) {
      for (const pending of this.pending.values()) {
        if (pending.kind === "get" && this.refInScope(pending.ref, args.scope, ref, ns)) {
          const idKey = relayResourceKey(pending.ref);
          this.generations.set(idKey, (this.generations.get(idKey) ?? 0) + 1);
        }
      }
    }

    // In-flight gets keep their assembler reservation until the (now stale)
    // terminal response arrives; scratch is released there and the result is
    // fenced by generation. Dropping it early would mislabel a stale-but-
    // complete object as a wire INVALID.

    for (const sub of this.subscriptions.values()) {
      const matches = sub.filter.ns === ns
        && (!ref || (sub.filter.kind === undefined || sub.filter.kind === ref.kind)
          && (!sub.filter.key || (sub.filter.key === ref.key && sub.filter.rendition === ref.rendition
            && (args.scope !== RELAY_INVALIDATE_SCOPE.REVISION || sub.revision === ref.revision))));
      if (matches) {
        sub.revision = undefined;
        sub.resyncRequired = true;
      }
    }
  }

  /** Dispatch one decoded RESPONSE/PUSH/INVALIDATE frame from the pump. */
  handleFrame(frame: RelayResourceIncomingFrame): void {
    if (frame.type === RELAY_TYPE.INVALIDATE) {
      if (frame.metadata.op === RELAY_OP.RESOURCE_INVALIDATE) this.applyInvalidate(frame.metadata);
      // cache.evict travels consumer -> authority only; receiving one is a no-op.
      return;
    }
    if (frame.type === RELAY_TYPE.RESPONSE) this.handleResponse(frame);
    else if (frame.type === RELAY_TYPE.PUSH) this.handlePush(frame);
  }

  private handleResponse(frame: RelayResourceIncomingFrame): void {
    const pending = this.pending.get(frame.correlation);
    if (!pending) return; // late response for a forgotten request; L1 consumed credit
    const op = typeof frame.metadata.op === "string" ? frame.metadata.op : "";

    if (frame.metadata.status === RELAY_STATUS.ERROR) {
      // An error envelope is terminal and need not repeat resource/value; the
      // frame layer already validated op/status/final. Only the error body
      // shape is checked here.
      const error = frame.metadata.error as RelayErrorBody | undefined;
      if (!error || typeof error.code !== "string" || !error.code) this.protocolErrors++;
      this.terminatePending(frame.correlation, pending);
      pending.complete({ ok: false, error: { code: error?.code ?? RELAY_ERROR.UNSUPPORTED, message: error?.message } });
      return;
    }

    if (validateRelayMetadata(`${op}.response`, frame.metadata)) { this.protocolErrors++; return; }

    if (pending.kind === "get") {
      this.deliverGet(frame, pending);
      return;
    }
    if (!frame.metadata.final) return; // accepted is non-terminal; control ops end final
    this.terminatePending(frame.correlation, pending);
    pending.complete({
      ok: true,
      value: { subscription: (frame.metadata.value as { subscription?: number } | undefined)?.subscription },
    });
  }

  private terminatePending(correlation: number, pending: Pending): void {
    this.pending.delete(correlation);
    if (pending.kind === "get" && pending.reserved) {
      this.assembler.release({ stream: pending.stream, channel: correlation });
      pending.reserved = false;
    }
  }

  private deliverGet(frame: RelayResourceIncomingFrame, pending: PendingGet): void {
    const meta = frame.metadata;
    const ref = meta.resource as RelayResourceRef;
    const value = meta.value as { notModified?: boolean } | undefined;

    if (value?.notModified) {
      if (!meta.final || !ref.revision) { this.protocolErrors++; return; }
      this.terminatePending(frame.correlation, pending);
      pending.complete({ ok: true, value: { notModified: true, revision: ref.revision! } });
      return;
    }

    if (frame.data.length) {
      if (!meta.transfer || !meta.resource) { this.protocolErrors++; return; }
      const result = this.assembler.push({
        stream: frame.stream,
        channel: frame.correlation,
        codec: frame.codec,
        resource: ref,
        digest: meta.digest as string | undefined,
        final: !!meta.final,
        transfer: meta.transfer as { id: number; offset: string; total: string },
        data: frame.data,
      });
      if (!result.ok) {
        this.terminatePending(frame.correlation, pending);
        pending.complete({ ok: false, error: { code: result.code } });
        return;
      }
      if (!result.complete) return;
      this.terminatePending(frame.correlation, pending);
      this.publishGet(pending, result.resource, result.codec, result.bytes, result.digest);
      return;
    }

    if (!meta.final) return;
    this.terminatePending(frame.correlation, pending);
    // Unchunked result: codec NONE carries the value in metadata (small
    // control objects); codec JSON without a data region is invalid.
    if (frame.codec !== RELAY_CODEC.NONE) { pending.complete({ ok: false, error: { code: RELAY_ERROR.INVALID } }); return; }
    const bytes = new Uint8Array(stringToUtf8(JSON.stringify(meta.value ?? null)));
    this.publishGet(pending, ref, RELAY_CODEC.NONE, bytes, undefined, meta.value);
  }

  private publishGet(pending: PendingGet, ref: RelayResourceRef, codec: number, data: Uint8Array,
    digest: string | undefined, value?: unknown) {
    if (this.generationFor(ref) !== pending.generation) {
      pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
      return;
    }
    if (ref.revision) this.storeEntry(ref);
    pending.complete({ ok: true, value: { ref, codec, data, digest, value } });
  }

  private handlePush(frame: RelayResourceIncomingFrame): void {
    if (validateRelayMetadata("resource.push", frame.metadata)) { this.protocolErrors++; return; }
    const meta = frame.metadata;
    const sub = this.subscriptions.get(meta.subscription as number);
    if (!sub) return; // post-unsubscribe/unknown push: consumed and dropped
    const ref = meta.resource as RelayResourceRef;

    if (frame.data.length) {
      if (!meta.transfer) { this.protocolErrors++; return; }
      const result = this.assembler.push({
        stream: frame.stream,
        channel: sub.id,
        codec: frame.codec,
        resource: ref,
        digest: meta.digest as string | undefined,
        final: !!meta.final,
        transfer: meta.transfer as { id: number; offset: string; total: string },
        data: frame.data,
      });
      if (!result.ok) { this.failSubscription(sub.id, { code: result.code }); return; }
      if (!result.complete) return;
      this.publishPush(sub, result.resource, result.codec, result.bytes, result.digest,
        meta.value, meta.baseRevision as string | undefined);
      return;
    }

    if (!meta.final) return;
    const data = new Uint8Array(stringToUtf8(JSON.stringify(meta.value ?? null)));
    this.publishPush(sub, ref, frame.codec, data, undefined, meta.value, meta.baseRevision as string | undefined);
  }

  private publishPush(sub: RelaySubscriptionEntry, ref: RelayResourceRef, codec: number,
    data: Uint8Array, digest: string | undefined, value: unknown, baseRevision: string | undefined) {
    const revision = ref.revision;
    if (!revision) { this.failSubscription(sub.id, { code: RELAY_ERROR.INVALID }); return; }
    let resyncRequired = sub.resyncRequired;

    if (sub.delivery === RELAY_DELIVERY.RELIABLE_DELTA) {
      // A delta applies only when its base is exactly the revision we hold.
      // After an invalidate the fence is empty; the first delta then needs a
      // full snapshot instead of guessing the base (§3.7 STALE_BASE).
      if (baseRevision !== undefined && (sub.revision === undefined || baseRevision !== sub.revision)) {
        sub.resyncRequired = true;
        resyncRequired = true;
      }
      if (resyncRequired) {
        sub.handler.onObject({ ref, codec, data, value, digest }, { resyncRequired: true });
        return;
      }
    } else {
      // latest-snapshot: re-delivering the held revision is idempotent; seq
      // order already guarantees newer revisions arrive later.
      if (sub.revision !== undefined && revision === sub.revision) return;
    }

    sub.revision = revision;
    sub.resyncRequired = false;
    if (ref.revision) this.storeEntry(ref);
    sub.handler.onObject({ ref, codec, data, value, digest }, { resyncRequired });
  }

  private failSubscription(id: number, error: RelayResourceError): void {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    this.closeSubscription(id);
    sub.handler.onEnd?.({ code: error.code });
  }

  private closeSubscription(id: number): void {
    const sub = this.subscriptions.get(id);
    if (sub) {
      this.subscriptions.delete(id);
      this.assembler.release({ stream: sub.stream, channel: id });
    }
  }

  private storeEntry(ref: RelayResourceRef): void {
    const generation = this.generationFor(ref);
    this.entries.set(relayResourceKey(ref), { ref, revision: ref.revision!, generation, stale: false });
  }

  private generationFor(ref: RelayResourceRef): number {
    const idKey = relayResourceKey(ref);
    return this.generations.get(idKey) ?? this.entries.get(idKey)?.generation ?? 0;
  }

  private refInScope(ref: RelayResourceRef, scope: string, target: RelayResourceRef | undefined, ns: string): boolean {
    if (scope === RELAY_INVALIDATE_SCOPE.NAMESPACE) return ref.ns === ns;
    if (!target) return false;
    return scope === RELAY_INVALIDATE_SCOPE.KEY ? refMatchesKeyScope(ref, target)
      : relayResourceKey(ref) === relayResourceKey(target);
  }

  localEntry(ref: RelayResourceRef): RelayLocalEntry | undefined {
    return this.entries.get(relayResourceKey(ref));
  }
  subscription(id: number): RelaySubscriptionEntry | undefined {
    return this.subscriptions.get(id);
  }
  /** Close all subscriptions and release scratch (relay.reset/session end). */
  resetStream(stream: number): void {
    for (const [id, sub] of this.subscriptions) {
      if (sub.stream === stream) { this.closeSubscription(id); sub.handler.onEnd?.(); }
    }
    for (const [correlation, pending] of this.pending) {
      if (pending.stream === stream) {
        this.pending.delete(correlation);
        if (pending.kind === "get" && pending.reserved) {
          this.assembler.release({ stream, channel: correlation });
          pending.reserved = false;
          pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
        } else {
          pending.complete({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED } });
        }
      }
    }
  }
  stats() {
    return {
      pending: this.pending.size,
      subscriptions: this.subscriptions.size,
      entries: this.entries.size,
      protocolErrors: this.protocolErrors,
    };
  }
}

// --- authority ---------------------------------------------------------------

export interface RelayAuthoritySubscription {
  id: number;
  stream: number;
  delivery: string;
  ns: string;
  ref?: RelayResourceRef;
  active: boolean;
}

export interface RelayResourceEnvelope {
  type: number;
  stream: number;
  correlation: number;
  metadata: Record<string, unknown>;
  data?: Uint8Array;
}

/** Provider-side resource registry and chunker. It validates and answers
 * resource REQUESTs and builds PUSH/INVALIDATE frames; the L1 provider pump
 * owns transmission, seq and credit. */
export class RelayResourceAuthority {
  private readonly subscriptionIds = new RelayIdAllocator();
  private readonly leaseIds = new RelayIdAllocator();
  private readonly transferIds = new RelayIdAllocator();
  private readonly subscriptions = new Map<number, RelayAuthoritySubscription>();
  private readonly leases = new Set<number>();

  constructor(private readonly opts: { maxWireBytes: number } = { maxWireBytes: 65536 }) {}

  answerSubscribe(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_SUBSCRIBE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_SUBSCRIBE, RELAY_ERROR.INVALID, invalid);
    const args = frame.metadata.args as { delivery: string; namespace?: string };
    const ref = frame.metadata.resource as RelayResourceRef | undefined;
    const ns = ref?.ns ?? args.namespace;
    if (!ns) return this.error(frame, RELAY_OP.RESOURCE_SUBSCRIBE, RELAY_ERROR.INVALID, "namespace required");
    const id = this.subscriptionIds.allocate();
    this.subscriptions.set(id, { id, stream: frame.stream, delivery: args.delivery, ns, ref, active: true });
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op: RELAY_OP.RESOURCE_SUBSCRIBE,
        ...(ref ? { resource: ref } : {}),
        status: RELAY_STATUS.OK, final: true, value: { subscription: id },
      },
    };
  }

  answerUnsubscribe(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_UNSUBSCRIBE, RELAY_ERROR.INVALID, invalid);
    const id = (frame.metadata.args as { subscription: number }).subscription;
    const sub = this.subscriptions.get(id);
    if (!sub || !sub.active) return this.error(frame, RELAY_OP.RESOURCE_UNSUBSCRIBE, RELAY_ERROR.NOT_FOUND, "unknown subscription");
    sub.active = false;
    this.subscriptions.delete(id);
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: { op: RELAY_OP.RESOURCE_UNSUBSCRIBE, status: RELAY_STATUS.OK, final: true },
    };
  }

  /** Allocate a session-scoped remote-residence lease (never reused). */
  allocateLease(): number {
    const id = this.leaseIds.allocate();
    this.leases.add(id);
    return id;
  }

  answerRelease(frame: { stream: number; correlation: number; metadata: Record<string, unknown> }):
    RelayResourceEnvelope {
    const invalid = validateRelayMetadata(`${RELAY_OP.RESOURCE_RELEASE}.request`, frame.metadata);
    if (invalid) return this.error(frame, RELAY_OP.RESOURCE_RELEASE, RELAY_ERROR.INVALID, invalid);
    const lease = (frame.metadata.args as { lease: number }).lease;
    if (!this.leases.delete(lease)) return this.error(frame, RELAY_OP.RESOURCE_RELEASE, RELAY_ERROR.NOT_FOUND, "unknown lease");
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: { op: RELAY_OP.RESOURCE_RELEASE, status: RELAY_STATUS.OK, final: true },
    };
  }

  /** resource.get admission: the assembled total must fit the ceiling the
   * requester reserved. Request-window capacity is BUSY at L1 admission. */
  checkGet(totalBytes: number, args: { maxObjectBytes: number }): RelayResourceError | null {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) return { code: RELAY_ERROR.INVALID };
    if (totalBytes > args.maxObjectBytes) {
      return { code: RELAY_ERROR.TOO_LARGE, message: `${totalBytes} > ${args.maxObjectBytes}` };
    }
    return null;
  }

  answerGetError(frame: { stream: number; correlation: number }, code: string, message = code): RelayResourceEnvelope {
    return this.error(frame, RELAY_OP.RESOURCE_GET, code, message);
  }

  answerNotModified(frame: { stream: number; correlation: number }, ref: RelayResourceRef): RelayResourceEnvelope {
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op: RELAY_OP.RESOURCE_GET, resource: ref,
        status: RELAY_STATUS.OK, final: true, value: { notModified: true },
      },
    };
  }

  /** Chunk one complete object into data-bearing frames. Every chunk repeats
   * resource/transfer/total/digest; offsets run contiguously from 0; the
   * transfer id is freshly allocated and never reused. */
  chunkObject(input: {
    type: typeof RELAY_TYPE.RESPONSE | typeof RELAY_TYPE.PUSH;
    stream: number;
    correlation: number; // 0 for PUSH
    subscription?: number;
    ref: RelayResourceRef;
    codec: number;
    data: Uint8Array;
    value?: Record<string, unknown>;
    /** Reliable-delta base; top-level metadata, never inside value (§3.4). */
    baseRevision?: string;
  }): RelayResourceEnvelope[] {
    const transferId = this.transferIds.allocate();
    const total = input.data.length;
    const digest = `sha256:${sha256Hex(input.data)}`;
    const metaFor = (offset: number, dataLen: number, final: boolean): Record<string, unknown> => {
      const meta: Record<string, unknown> = input.type === RELAY_TYPE.PUSH
        ? { op: "resource.push", resource: input.ref, subscription: input.subscription, final }
        : { op: RELAY_OP.RESOURCE_GET, resource: input.ref, status: RELAY_STATUS.OK, final };
      if (input.value !== undefined) meta.value = input.value;
      if (input.baseRevision !== undefined) meta.baseRevision = input.baseRevision;
      meta.transfer = { id: transferId, offset: hex16(offset), total: hex16(total) };
      meta.digest = digest;
      return meta;
    };
    const frames: RelayResourceEnvelope[] = [];
    if (total === 0) {
      frames.push({
        type: input.type, stream: input.stream, correlation: input.correlation,
        metadata: metaFor(0, 0, true), data: new Uint8Array(0),
      });
      return frames;
    }
    let offset = 0;
    while (offset < total) {
      // Size the data region from the metadata length at this offset (the
      // hex offset width is fixed at 16, so all chunks share it).
      const remaining = total - offset;
      let dataLen = remaining;
      let final = false;
      for (;;) {
        final = offset + dataLen === total;
        const metaLen = stringToUtf8(JSON.stringify(metaFor(offset, dataLen, final))).length;
        const fits = 48 + metaLen + dataLen <= this.opts.maxWireBytes;
        if (fits || dataLen === 0) break;
        dataLen = Math.max(0, this.opts.maxWireBytes - 48 - metaLen);
      }
      if (dataLen === 0) throw new Error("relay metadata alone exceeds maxWireBytes");
      frames.push({
        type: input.type, stream: input.stream, correlation: input.correlation,
        metadata: metaFor(offset, dataLen, final),
        data: input.data.subarray(offset, offset + dataLen),
      });
      offset += dataLen;
    }
    return frames;
  }

  /** Build an authority INVALIDATE. Namespace scope may name only an ns;
   * revision/key scopes require the resource ref. */
  buildInvalidate(input:
    | { scope: typeof RELAY_INVALIDATE_SCOPE.NAMESPACE; ns: string; reason?: string }
    | { scope: typeof RELAY_INVALIDATE_SCOPE.KEY | typeof RELAY_INVALIDATE_SCOPE.REVISION; ref: RelayResourceRef; reason?: string },
  ): RelayResourceEnvelope {
    const metadata: Record<string, unknown> = { op: RELAY_OP.RESOURCE_INVALIDATE };
    const args: Record<string, unknown> = { scope: input.scope };
    if ("ns" in input) {
      args.namespace = input.ns;
      if (input.reason) args.reason = input.reason;
    } else {
      metadata.resource = input.ref;
      if (input.reason) args.reason = input.reason;
    }
    metadata.args = args;
    return { type: RELAY_TYPE.INVALIDATE, stream: 0, correlation: 0, metadata };
  }

  subscriptionEntry(id: number): RelayAuthoritySubscription | undefined {
    return this.subscriptions.get(id);
  }
  leaseCount(): number {
    return this.leases.size;
  }
  idsAllocated() {
    return {
      subscription: this.subscriptionIds.allocated(),
      lease: this.leaseIds.allocated(),
      transfer: this.transferIds.allocated(),
    };
  }

  private error(frame: { stream: number; correlation: number }, op: string, code: string, message: string): RelayResourceEnvelope {
    return {
      type: RELAY_TYPE.RESPONSE, stream: frame.stream, correlation: frame.correlation,
      metadata: {
        op, status: RELAY_STATUS.ERROR, final: true,
        error: { code, message: message.slice(0, 160) },
      },
    };
  }
}

// --- resource-cache adapter (§3.8 reserve-then-load) -------------------------

export interface RelayCacheAdapterDeps {
  client: RelayResourceClient;
  stream: number;
  accept: number[];
  /** Resident cost the collection reserved for this input. */
  maxObjectBytes: number;
  ifRevisionFor?(input: RelayResourceRef): string | undefined;
}

/** Adapt a relay get to the resource-cache ResourceLoad contract. The
 * collection reserves cost before load() runs (reserve-then-load); a BUSY
 * admission declines the start (resource-cache retries on a later frame),
 * and a terminal error fails the entry like any loader error. */
export function createRelayResourceLoad(deps: RelayCacheAdapterDeps):
  ResourceLoad<RelayResourceRef, Uint8Array> {
  return (ref, complete) => {
    const outcome = deps.client.get(
      deps.stream,
      ref,
      { accept: deps.accept, maxObjectBytes: deps.maxObjectBytes, ifRevision: deps.ifRevisionFor?.(ref) },
      (result) => {
        if (!result.ok) { complete(result); return; }
        if ("notModified" in result.value) {
          // The collection already holds the bytes; the cache keeps them.
          complete({ ok: true, value: new Uint8Array(0) });
          return;
        }
        complete({ ok: true, value: result.value.data });
      },
    );
    if ("correlation" in outcome) {
      const correlation = outcome.correlation;
      return { cancel: () => deps.client.cancel(correlation) };
    }
    if (outcome.code === RELAY_ERROR.BUSY) return false;
    throw new Error(`relay get refused: ${outcome.code}`);
  };
}

export type { RelayResourceErrorCode };
