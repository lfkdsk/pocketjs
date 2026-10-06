// PocketJS socket SDK — one bounded WebSocket client over globalThis.socket.
// The native contract lives in contracts/spec/socket.ts. This file is
// framework neutral and serves ./socket, ./vue-vapor/socket and
// ./octane/socket.

import {
  SOCKET_CLOSE,
  SOCKET_DEFAULT_TIMEOUT_MS,
  SOCKET_ERROR,
  SOCKET_MAX_CLOSE_REASON_BYTES,
  SOCKET_MAX_CONNECTIONS,
  SOCKET_MAX_EVENTS_PER_TICK,
  SOCKET_MAX_MESSAGE_BYTES,
  SOCKET_MAX_PROTOCOL_BYTES,
  SOCKET_MAX_PROTOCOLS,
  SOCKET_MAX_RECV_QUEUE_BYTES,
  SOCKET_MAX_SEND_QUEUE_BYTES,
  SOCKET_MAX_TIMEOUT_MS,
  SOCKET_MAX_URL_BYTES,
  type SocketErrorCode,
} from "../../contracts/spec/socket.ts";
import { stringToUtf8 } from "./bytes.ts";
import { registerServicePump } from "./services.ts";

export {
  SOCKET_CLOSE,
  SOCKET_DEFAULT_TIMEOUT_MS,
  SOCKET_MAX_CLOSE_REASON_BYTES,
  SOCKET_MAX_CONNECTIONS,
  SOCKET_MAX_EVENTS_PER_TICK,
  SOCKET_MAX_MESSAGE_BYTES,
  SOCKET_MAX_PROTOCOL_BYTES,
  SOCKET_MAX_PROTOCOLS,
  SOCKET_MAX_RECV_QUEUE_BYTES,
  SOCKET_MAX_SEND_QUEUE_BYTES,
  SOCKET_MAX_TIMEOUT_MS,
  SOCKET_MAX_URL_BYTES,
};
export type { SocketErrorCode };

export interface SocketOps {
  /** Accepted or refused synchronously; -1 means read lastError(). */
  open(url: string, metaJson: string): number;
  /** The payload is borrowed for this synchronous call. Returns the queued
   * outbound bytes including this message, or -1. */
  send(handle: number, data: ArrayBuffer, isText: boolean): number;
  close(handle: number, code: number, reason: string): number;
  /** One JSON array containing the entire event batch visible this tick. */
  poll(): string | undefined;
  /** Copy a binary message of the last batch into an exactly-sized buffer. */
  take(messageId: number, into: ArrayBuffer): number;
  lastError(): string;
}

export interface SocketOptions {
  /** Sec-WebSocket-Protocol offers (tokens, at most 8 / 512 bytes). */
  protocols?: string[];
  /** Opening handshake bound, 1..60000; defaults to 10000. */
  timeoutMs?: number;
}

export interface SocketCloseEvent {
  code: number;
  reason: string;
  clean: boolean;
}

export type SocketReadyState = "connecting" | "open" | "closing" | "closed";

export class SocketError extends Error {
  readonly code: SocketErrorCode;

  constructor(code: SocketErrorCode, message: string) {
    super(message);
    this.name = "SocketError";
    this.code = code;
  }
}

export interface PocketSocket {
  readonly url: string;
  /** Subprotocol the server selected; "" until open or when none. */
  readonly protocol: string;
  readonly readyState: SocketReadyState;
  onOpen?: () => void;
  onMessage?: (data: string | Uint8Array) => void;
  /** Informational; a close always follows. */
  onError?: (error: SocketError) => void;
  /** Exactly once per socket. */
  onClose?: (event: SocketCloseEvent) => void;
  /** true = queued; false = refused with `backpressure`. Any other refusal
   * throws SocketError. */
  send(data: string | Uint8Array | ArrayBuffer): boolean;
  /** Start the closing handshake; repeated calls while closing are no-ops. */
  close(code?: number, reason?: string): void;
}

export function socketHost(): SocketOps | null {
  const ns = (globalThis as { socket?: unknown }).socket;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<SocketOps>;
  return typeof ops.open === "function" &&
      typeof ops.send === "function" &&
      typeof ops.close === "function" &&
      typeof ops.poll === "function" &&
      typeof ops.take === "function" &&
      typeof ops.lastError === "function"
    ? (ops as SocketOps)
    : null;
}

function errorCode(value: unknown): SocketErrorCode {
  const code = String(value);
  for (const known of Object.values(SOCKET_ERROR)) {
    if (known === code) return known;
  }
  return SOCKET_ERROR.other;
}

function refusal(ops: SocketOps): SocketError {
  const detail = ops.lastError() || "other: request refused";
  const split = detail.indexOf(":");
  const code = errorCode(split < 0 ? SOCKET_ERROR.other : detail.slice(0, split));
  const message = split < 0 ? detail : detail.slice(split + 1).trim();
  return new SocketError(code, `socket: ${message}`);
}

function invalid(message: string): SocketError {
  return new SocketError(SOCKET_ERROR.invalidRequest, `socket: ${message}`);
}

class Socket implements PocketSocket {
  readonly url: string;
  onOpen?: () => void;
  onMessage?: (data: string | Uint8Array) => void;
  onError?: (error: SocketError) => void;
  onClose?: (event: SocketCloseEvent) => void;
  /** @internal */ _protocol = "";
  /** @internal */ _state: SocketReadyState = "connecting";
  private readonly ops: SocketOps;
  private readonly handle: number;

  constructor(ops: SocketOps, handle: number, url: string) {
    this.ops = ops;
    this.handle = handle;
    this.url = url;
  }

  get protocol(): string {
    return this._protocol;
  }

  get readyState(): SocketReadyState {
    return this._state;
  }

  send(data: string | Uint8Array | ArrayBuffer): boolean {
    let buffer: ArrayBuffer;
    let isText = false;
    if (typeof data === "string") {
      buffer = stringToUtf8(data).buffer as ArrayBuffer;
      isText = true;
    } else if (data instanceof Uint8Array) {
      buffer = data.slice().buffer as ArrayBuffer;
    } else if (data instanceof ArrayBuffer) {
      buffer = data;
    } else {
      throw invalid("message must be a string, Uint8Array or ArrayBuffer");
    }
    if (this._state !== "open") {
      throw new SocketError(SOCKET_ERROR.closed, "socket: socket is not open");
    }
    if (buffer.byteLength > SOCKET_MAX_MESSAGE_BYTES) {
      throw new SocketError(
        SOCKET_ERROR.messageTooLarge,
        `socket: message exceeds ${SOCKET_MAX_MESSAGE_BYTES} bytes`,
      );
    }
    const queued = this.ops.send(this.handle, buffer, isText);
    if (Number.isInteger(queued) && queued >= 0) return true;
    const error = refusal(this.ops);
    if (error.code === SOCKET_ERROR.backpressure) return false;
    throw error;
  }

  close(code: number = SOCKET_CLOSE.normal, reason = ""): void {
    if (code !== SOCKET_CLOSE.normal && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) {
      throw invalid("close code must be 1000 or 3000..4999");
    }
    if (typeof reason !== "string" || stringToUtf8(reason).byteLength > SOCKET_MAX_CLOSE_REASON_BYTES) {
      throw invalid(`close reason exceeds ${SOCKET_MAX_CLOSE_REASON_BYTES} bytes`);
    }
    if (this._state !== "connecting" && this._state !== "open") return;
    if (this.ops.close(this.handle, code, reason) < 0) throw refusal(this.ops);
    this._state = "closing";
  }

  /** @internal Close without throwing after a protocol failure. */
  _abandon(): void {
    if (this._state !== "connecting" && this._state !== "open") return;
    this.ops.close(this.handle, SOCKET_CLOSE.normal, "");
    this._state = "closing";
  }
}

const live = new Map<number, Socket>();
/** Handles the SDK gave up on after a malformed batch. They still count
 * toward the connection limit until the core reports their close, so the
 * pump keeps polling (without dispatching) until then — at most
 * ABANDON_TICKS ticks, after which a close lost inside the malformed batch
 * no longer keeps the pump registered. */
const abandoned = new Set<number>();
const ABANDON_TICKS = 600;
let abandonedTicks = 0;
let stopPump: (() => void) | null = null;
let activeOps: SocketOps | null = null;

function idle(): void {
  if (live.size === 0 && abandoned.size === 0 && stopPump) {
    stopPump();
    stopPump = null;
    activeOps = null;
  }
}

interface Dispatch {
  failed: boolean;
  error: unknown;
}

function call(state: Dispatch, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (!state.failed) {
      state.failed = true;
      state.error = error;
    }
  }
}

function protocolFailure(state: Dispatch, socket: Socket, message: string): void {
  if (socket._state !== "connecting" && socket._state !== "open") return;
  const error = new SocketError(SOCKET_ERROR.protocol, `socket: ${message}`);
  call(state, () => socket.onError?.(error));
  socket._abandon();
}

function dispatch(state: Dispatch, ops: SocketOps, event: Record<string, unknown>): void {
  const handle = event.h as number;
  if (!Number.isInteger(handle)) return;
  const socket = live.get(handle);
  if (!socket) {
    if (event.t === "close") abandoned.delete(handle);
    return;
  }
  switch (event.t) {
    case "open": {
      if (socket._state !== "connecting") return;
      socket._state = "open";
      socket._protocol = typeof event.protocol === "string" ? event.protocol : "";
      call(state, () => socket.onOpen?.());
      return;
    }
    case "message": {
      if (event.text === true && typeof event.data === "string") {
        const data = event.data;
        call(state, () => socket.onMessage?.(data));
        return;
      }
      const id = event.m;
      const bytes = event.bytes;
      if (
        event.text !== false ||
        !Number.isInteger(id) ||
        !Number.isInteger(bytes) ||
        (bytes as number) < 0 ||
        (bytes as number) > SOCKET_MAX_MESSAGE_BYTES
      ) {
        protocolFailure(state, socket, "malformed message event");
        return;
      }
      const body = new ArrayBuffer(bytes as number);
      if (ops.take(id as number, body) !== bytes) {
        protocolFailure(state, socket, "binary message transfer failed");
        return;
      }
      const data = new Uint8Array(body);
      call(state, () => socket.onMessage?.(data));
      return;
    }
    case "error": {
      const error = new SocketError(errorCode(event.code), String(event.message || event.code));
      call(state, () => socket.onError?.(error));
      return;
    }
    case "close": {
      live.delete(handle);
      socket._state = "closed";
      const close: SocketCloseEvent = {
        code: Number.isInteger(event.code) ? (event.code as number) : SOCKET_CLOSE.abnormal,
        reason: typeof event.reason === "string" ? event.reason : "",
        clean: event.clean === true,
      };
      call(state, () => socket.onClose?.(close));
      return;
    }
  }
}

/** Internal module service hook. It performs exactly one native poll call and
 * only exists in the frame pump while at least one socket is live. Callback
 * exceptions do not stop the batch; the first one is rethrown after it. */
export function __pumpSocket(): void {
  const ops = activeOps;
  if (!ops || (live.size === 0 && abandoned.size === 0)) {
    idle();
    return;
  }
  if (abandoned.size > 0 && ++abandonedTicks > ABANDON_TICKS) abandoned.clear();
  const state: Dispatch = { failed: false, error: undefined };
  const batch = ops.poll();
  if (batch !== undefined) {
    let events: unknown = null;
    try {
      events = JSON.parse(batch);
    } catch {
      // handled as a protocol failure below
    }
    if (!Array.isArray(events)) {
      abandonedTicks = 0;
      for (const [handle, socket] of [...live]) {
        live.delete(handle);
        abandoned.add(handle);
        if (socket._state === "connecting" || socket._state === "open") {
          ops.close(handle, SOCKET_CLOSE.normal, "");
        }
        socket._state = "closed";
        const error = new SocketError(SOCKET_ERROR.protocol, "socket: malformed event batch");
        call(state, () => socket.onError?.(error));
        call(state, () => socket.onClose?.({ code: SOCKET_CLOSE.abnormal, reason: "", clean: false }));
      }
    } else {
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        dispatch(state, ops, event as Record<string, unknown>);
      }
    }
  }
  idle();
  if (state.failed) throw state.error;
}

function integerInRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be ${min}..${max}`);
  }
  return value;
}

const REG_NAME = /^[A-Za-z0-9\-._~!$&'()*+,;=]+$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
const DEC_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;
const PORT = /^[0-9]{1,5}$/;

function isHexDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66);
}

/** Four decimal parts 0..255 without leading zeros. */
function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => DEC_OCTET.test(part) && Number(part) <= 255);
}

/** RFC 3986 IPv6address: 1-4 hex digits per group, at most one `::` standing
 * for one or more zero groups, and an optional IPv4 tail counted as two
 * groups. */
function isIpv6(text: string): boolean {
  let compressed = text.startsWith("::");
  let i = compressed ? 2 : 0;
  let groups = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && isHexDigit(text.charCodeAt(j))) j++;
    if (text[j] === ".") {
      if (!isIpv4(text.slice(i))) return false;
      groups += 2;
      break;
    }
    if (j === i || j - i > 4) return false;
    groups++;
    if (j === text.length) break;
    if (text[j] !== ":") return false;
    i = j + 1;
    if (text[i] === ":") {
      if (compressed) return false;
      compressed = true;
      i++;
    } else if (i === text.length) {
      return false;
    }
  }
  return compressed ? groups <= 7 : groups === 8;
}

/** A reg-name, or dotted-decimal IPv4 when the last label is numeric. */
function isHostName(host: string): boolean {
  if (!REG_NAME.test(host)) return false;
  const labels = host.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  return !NUMERIC_LABEL.test(labels[labels.length - 1]) || isIpv4(host);
}

/** The URL rule of contracts/spec/socket.ts (pocket-socket is_ws_url): no
 * whitespace, control bytes or fragment; every `%` followed by two hex
 * digits. The authority runs to the first `/` or `?`: no userinfo, an
 * optional port 1..65535, and a host that is a bracketed RFC 3986 IPv6
 * literal without a zone id, a dotted-decimal IPv4 address, or an ASCII
 * reg-name without `%` whose last label is not numeric (WHATWG URL parses
 * such a host as IPv4). */
function isWsUrl(url: unknown): url is string {
  if (typeof url !== "string" || stringToUtf8(url).byteLength > SOCKET_MAX_URL_BYTES) return false;
  const rest = url.startsWith("ws://") ? url.slice(5) : url.startsWith("wss://") ? url.slice(6) : null;
  if (rest === null) return false;
  let end = rest.length;
  for (let i = 0; i < rest.length; i++) {
    const c = rest.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f || c === 0x23) return false;
    if (c === 0x25 && !(isHexDigit(rest.charCodeAt(i + 1)) && isHexDigit(rest.charCodeAt(i + 2)))) return false;
    if (end === rest.length && (c === 0x2f || c === 0x3f)) end = i;
  }
  const authority = rest.slice(0, end);
  let after: string;
  if (authority[0] === "[") {
    const close = authority.indexOf("]");
    if (close < 0 || !isIpv6(authority.slice(1, close))) return false;
    after = authority.slice(close + 1);
  } else {
    const colon = authority.indexOf(":");
    if (!isHostName(colon < 0 ? authority : authority.slice(0, colon))) return false;
    after = colon < 0 ? "" : authority.slice(colon);
  }
  if (after === "") return true;
  if (after[0] !== ":") return false;
  const port = after.slice(1);
  return PORT.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

function normalizeProtocols(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw invalid("protocols must be an array of strings");
  const protocols: string[] = [];
  let bytes = 0;
  for (const protocol of input) {
    if (typeof protocol !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)) {
      throw invalid(`invalid protocol ${JSON.stringify(String(protocol))}`);
    }
    if (protocols.includes(protocol)) throw invalid(`duplicate protocol ${JSON.stringify(protocol)}`);
    bytes += protocol.length;
    protocols.push(protocol);
  }
  if (protocols.length > SOCKET_MAX_PROTOCOLS || bytes > SOCKET_MAX_PROTOCOL_BYTES) {
    throw invalid(
      `at most ${SOCKET_MAX_PROTOCOLS} protocols of ${SOCKET_MAX_PROTOCOL_BYTES} bytes in total`,
    );
  }
  return protocols;
}

/** Open one WebSocket client connection. Refusals throw SocketError
 * synchronously; an accepted socket reports `onOpen` or `onClose` from the
 * service pump at a later tick, never during this call. */
export function openSocket(url: string, options: SocketOptions = {}): PocketSocket {
  const ops = socketHost();
  if (!ops) {
    throw new SocketError(SOCKET_ERROR.unavailable, "socket: host did not mount the socket module");
  }
  if (!isWsUrl(url)) {
    throw invalid(
      `url must be absolute ws:// or wss:// with a host and an optional port 1..65535, ` +
        `without userinfo or a fragment, at most ${SOCKET_MAX_URL_BYTES} bytes`,
    );
  }
  const protocols = normalizeProtocols(options.protocols);
  const timeoutMs = integerInRange(
    options.timeoutMs ?? SOCKET_DEFAULT_TIMEOUT_MS,
    1,
    SOCKET_MAX_TIMEOUT_MS,
    "timeoutMs",
  );
  if (activeOps && activeOps !== ops) {
    throw new SocketError(
      SOCKET_ERROR.unavailable,
      "socket: mounted host changed while sockets are live",
    );
  }
  const handle = ops.open(url, JSON.stringify({ protocols, timeoutMs }));
  if (!Number.isInteger(handle) || handle < 0) throw refusal(ops);
  const socket = new Socket(ops, handle, url);
  live.set(handle, socket);
  activeOps = ops;
  if (!stopPump) stopPump = registerServicePump(__pumpSocket);
  return socket;
}
