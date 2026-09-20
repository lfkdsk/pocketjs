/** Guest side of the relay L0 byte channel (contracts/spec/relay-channel.ts).
 *
 * It owns one scratch buffer for its lifetime and moves at most
 * RELAY_CHANNEL.deliveriesPerFrame records into the session per frame, so a
 * busy companion costs the guest heap nothing and the frame budget a fixed
 * amount. Everything above the record boundary — HELLO, credit, chunking,
 * assembly — belongs to RelayEndpoint; this module never inspects a frame.
 */

import { RELAY_CHANNEL, relayChannelRxLimits, type RelayChannelOps } from "../../../contracts/spec/relay-channel.ts";
import { registerServicePump } from "../services.ts";
import type { RelayPeerContext, RelaySendStatus, RelayTransportAdapter } from "./session.ts";

export { RELAY_CHANNEL, relayChannelRxLimits };
export type { RelayChannelOps };

export interface RelayChannelStats {
  session: number;
  /** Records handed to the host and accepted. */
  sent: number;
  /** Records the host refused for want of credit. */
  refused: number;
  /** Records delivered to the session. */
  received: number;
  /** Records the host reported as oversized for the scratch buffer. */
  oversized: number;
  bytesIn: number;
  bytesOut: number;
  /** Native counters when the host publishes them. */
  native?: string;
}

export interface RelayChannel {
  /** The L0 adapter a RelayEndpoint sends through. */
  readonly transport: RelayTransportAdapter;
  /** Positive authenticated attachment generation; zero while detached. */
  session(): number;
  /** Deliver inbound records to the handler; returns how many were moved.
   * Registered as a service pump, so a guest that never calls it still
   * drains one budget per frame. */
  step(): number;
  /** The single record sink. Replacing it replaces the session above. */
  onRecord(handler: (record: Uint8Array) => void): void;
  stats(): RelayChannelStats;
  /** Release the service pump; the ops stay owned by the host. */
  close(): void;
}

const nativeOps = () => (globalThis as unknown as { relayChannel?: RelayChannelOps }).relayChannel;

/** Build a channel over explicit ops. Tests and desktop hosts pass their own;
 * `relayChannel()` passes the native ones. */
export function createRelayChannel(ops: RelayChannelOps, peer: RelayPeerContext): RelayChannel {
  const scratch = new Uint8Array(RELAY_CHANNEL.recordBytes);
  let handler: ((record: Uint8Array) => void) | undefined;
  let sent = 0, refused = 0, received = 0, oversized = 0, bytesIn = 0, bytesOut = 0;
  let submissions = 0, pumped = false;
  const transport: RelayTransportAdapter = {
    peer,
    trySend(bytes: Uint8Array): RelaySendStatus {
      if (ops.session() <= 0) return "offline";
      // The record is one slot by contract; a longer one is a producer bug
      // above this layer, never a truncated write.
      if (bytes.length > RELAY_CHANNEL.recordBytes) return "offline";
      if (submissions >= RELAY_CHANNEL.submissionsPerFrame) { refused++; return "busy"; }
      if (!ops.send(bytes)) { refused++; return "busy"; }
      submissions++; sent++; bytesOut += bytes.length;
      return "accepted";
    },
  };
  const step = (): number => {
    submissions = 0;
    if (!handler || ops.session() <= 0) return 0;
    let moved = 0;
    for (let i = 0; i < RELAY_CHANNEL.deliveriesPerFrame; i++) {
      const length = ops.take(scratch);
      if (length <= 0) break;
      if (length > scratch.length) { oversized++; continue; }
      received++; bytesIn += length; moved++;
      handler(scratch.subarray(0, length));
    }
    return moved;
  };
  let unregister: (() => void) | undefined;
  return {
    transport,
    session: () => ops.session(),
    step() {
      if (!pumped) { pumped = true; unregister = registerServicePump(() => { step(); }); }
      return step();
    },
    onRecord(next) { handler = next; if (!pumped) { pumped = true; unregister = registerServicePump(() => { step(); }); } },
    stats: () => ({ session: ops.session(), sent, refused, received, oversized, bytesIn, bytesOut, native: ops.stats?.() }),
    close() { unregister?.(); unregister = undefined; pumped = false; handler = undefined; },
  };
}

let channel: RelayChannel | undefined;

/** The realm's relay channel, or undefined on a host without the lane. One
 * channel per realm: the ops carry one authenticated attachment. */
export function relayChannel(peer?: RelayPeerContext): RelayChannel | undefined {
  if (channel) return channel;
  const ops = nativeOps();
  if (!ops) return undefined;
  channel = createRelayChannel(ops, peer ?? { id: "companion", grants: [] });
  return channel;
}

/** Tests and hosts that rebuild the realm. */
export function resetRelayChannel(): void {
  channel?.close();
  channel = undefined;
}
