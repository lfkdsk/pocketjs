// Type surface of socket.js for the TS tests. The .js stays plain ESM so the
// browser loads it without a build step.

import type { SocketOps } from "../../framework/src/socket-api.ts";

export interface WebSocketHost {
  ns: SocketOps;
  /** Credit written bytes and admit at most the per-tick event budget. */
  beginFrame(): void;
  /** Close every socket and drop all state (called on reload). */
  reset(): void;
}

export declare function createSocketHost(WebSocketImpl?: unknown): WebSocketHost;
