// Browser dev host for the PocketJS SOCKET module. The browser WebSocket is
// the physical transport; this adapter supplies the bounded contract, the
// connection state machine and the tick batching of contracts/spec/socket.ts
// (mirroring engine/crates/pocket-socket) without exposing the WHATWG
// WebSocket object to the guest.
//
// Every message is charged its payload bytes plus MESSAGE_OVERHEAD_BYTES in
// both directions, so empty messages are bounded as well.
//
// Outbound accounting: the browser exposes only ws.bufferedAmount, the
// unwritten payload bytes. Each connection keeps the payload lengths of its
// sent messages in order; at beginFrame() the messages wholly before the last
// bufferedAmount bytes count as written and are dropped. The queued charge is
// then bufferedAmount plus the overhead of each message still held, and send()
// adds its own charge until the next boundary. Written messages are therefore
// credited back only at a tick boundary, the same rule the native core applies
// with take_sent().
//
// Inbound accounting: a browser WebSocket cannot stop reading, so the charge
// of messages received but not yet moved into a tick batch is counted per
// connection; above MAX_RECV_QUEUE_BYTES the connection fails with `overflow`.

const MAX_CONNECTIONS = 4;
const MAX_URL_BYTES = 2048;
const MAX_PROTOCOLS = 8;
const MAX_PROTOCOL_BYTES = 512;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_SEND_QUEUE_BYTES = 256 * 1024;
const MAX_RECV_QUEUE_BYTES = 256 * 1024;
const MESSAGE_OVERHEAD_BYTES = 64;
const MAX_EVENTS_PER_TICK = 64;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CLOSE_REASON_BYTES = 123;
const CLOSE_ABNORMAL = 1006;
const CLOSE_MESSAGE_TOO_BIG = 1009;

// WebSocket.readyState OPEN (WHATWG); spelled out so a scripted transport
// does not need the static constants.
const WS_OPEN = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function utf8Bytes(text) {
  return encoder.encode(text).byteLength;
}

const REG_NAME = /^[A-Za-z0-9\-._~!$&'()*+,;=]+$/;
const NUMERIC_LABEL = /^(?:[0-9]+|0[xX][0-9A-Fa-f]*)$/;
const DEC_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;
const PORT = /^[0-9]{1,5}$/;

function isHexDigit(c) {
  return (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66);
}

/** Four decimal parts 0..255 without leading zeros. */
function isIpv4(text) {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((part) => DEC_OCTET.test(part) && Number(part) <= 255);
}

/** RFC 3986 IPv6address: 1-4 hex digits per group, at most one `::` standing
 * for one or more zero groups, and an optional IPv4 tail counted as two
 * groups. */
function isIpv6(text) {
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
function isHostName(host) {
  if (!REG_NAME.test(host)) return false;
  const labels = host.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  return !NUMERIC_LABEL.test(labels[labels.length - 1]) || isIpv4(host);
}

/** Absolute ws:// or wss:// URL, no whitespace or control bytes, no fragment,
 * within the portable length (pocket-socket is_ws_url); every `%` followed by
 * two hex digits. The authority runs to the first `/` or `?`: no userinfo, an
 * optional port 1..65535, and a host that is a bracketed RFC 3986 IPv6
 * literal without a zone id, a dotted-decimal IPv4 address, or an ASCII
 * reg-name without `%` whose last label is not numeric (WHATWG URL parses
 * such a host as IPv4). */
function isWsUrl(url) {
  if (typeof url !== "string" || utf8Bytes(url) > MAX_URL_BYTES) return false;
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
  let after;
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

function isToken(value) {
  return typeof value === "string" && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

/** Returns an error message, or null when the offer list is valid. */
function protocolError(protocols) {
  if (!Array.isArray(protocols)) return "protocols must be an array";
  let bytes = 0;
  for (const protocol of protocols) bytes += typeof protocol === "string" ? utf8Bytes(protocol) : 0;
  if (protocols.length > MAX_PROTOCOLS || bytes > MAX_PROTOCOL_BYTES) {
    return `at most ${MAX_PROTOCOLS} protocols of ${MAX_PROTOCOL_BYTES} bytes in total`;
  }
  for (let i = 0; i < protocols.length; i++) {
    const protocol = protocols[i];
    if (!isToken(protocol)) return `invalid protocol ${JSON.stringify(String(protocol))}`;
    if (protocols.indexOf(protocol) < i) return `duplicate protocol ${JSON.stringify(protocol)}`;
  }
  return null;
}

export function createSocketHost(WebSocketImpl = globalThis.WebSocket) {
  let nextHandle = 1;
  let nextMessage = 1;
  let lastError = "";
  // handle -> connection. A handle stays here until poll() returns its close
  // event, which is what the connection limit counts.
  const connections = new Map();
  const completed = []; // transport facts, not guest-visible yet
  const visible = []; // events admitted at beginFrame(), drained by poll()
  let staged = new Map(); // message id -> Uint8Array for the next poll()
  let polled = new Map(); // message id -> Uint8Array of the last poll()

  function refuse(code, message) {
    lastError = `${code}: ${message}`;
    return -1;
  }

  function allocateHandle() {
    for (;;) {
      const handle = nextHandle;
      nextHandle = handle === 0x7fffffff ? 1 : handle + 1;
      if (!connections.has(handle)) return handle;
    }
  }

  // --- transport side: browser events become `completed` facts ------------

  /** End the transport for `conn`: no later browser event is reported. */
  function finish(conn) {
    conn.done = true;
    clearTimeout(conn.timer);
    conn.timer = undefined;
  }

  function abort(conn) {
    try {
      conn.ws.close();
    } catch {
      // the browser socket is already closing; its events are ignored
    }
  }

  /** Fail the transport with an error and a synthesized close (no frame). */
  function fail(conn, code, message, closeCode) {
    finish(conn);
    abort(conn);
    completed.push({ t: "error", h: conn.handle, code, message });
    completed.push({ t: "close", h: conn.handle, code: closeCode, reason: "", clean: false });
  }

  function attach(conn) {
    const { ws, handle } = conn;
    ws.addEventListener("open", () => {
      if (conn.done) return;
      clearTimeout(conn.timer);
      conn.timer = undefined;
      conn.opened = true;
      completed.push({ t: "open", h: handle, protocol: typeof ws.protocol === "string" ? ws.protocol : "" });
    });
    ws.addEventListener("message", (event) => {
      if (conn.done) return;
      const data = event.data;
      let fact;
      let size;
      if (typeof data === "string") {
        size = utf8Bytes(data);
        fact = { t: "message", h: handle, text: true, data, size };
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const body = data instanceof ArrayBuffer
          ? new Uint8Array(data).slice()
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        size = body.byteLength;
        fact = { t: "message", h: handle, text: false, body, size };
      } else {
        fail(conn, "protocol", "unsupported message payload", CLOSE_ABNORMAL);
        return;
      }
      if (size > MAX_MESSAGE_BYTES) {
        fail(conn, "message_too_large", `message exceeds ${MAX_MESSAGE_BYTES} bytes`, CLOSE_MESSAGE_TOO_BIG);
        return;
      }
      if (conn.received + size + MESSAGE_OVERHEAD_BYTES > MAX_RECV_QUEUE_BYTES) {
        fail(conn, "overflow", `more than ${MAX_RECV_QUEUE_BYTES} received bytes undelivered`, CLOSE_ABNORMAL);
        return;
      }
      conn.received += size + MESSAGE_OVERHEAD_BYTES;
      completed.push(fact);
    });
    ws.addEventListener("error", () => {
      if (conn.done) return;
      completed.push(conn.opened
        ? { t: "error", h: handle, code: "other", message: "websocket error" }
        : { t: "error", h: handle, code: "connect", message: "websocket connection failed" });
    });
    ws.addEventListener("close", (event) => {
      if (conn.done) return;
      finish(conn);
      const code = Number.isInteger(event.code) && event.code > 0 && event.code <= 0xffff
        ? event.code
        : CLOSE_ABNORMAL;
      // 1005/1006/1015 are never sent on the wire; any other code came from a
      // received close frame. Some clients (Bun) report wasClean=false for a
      // peer-initiated close that completed the handshake.
      const framed = code !== 1005 && code !== CLOSE_ABNORMAL && code !== 1015;
      completed.push({
        t: "close",
        h: handle,
        code,
        reason: typeof event.reason === "string" ? event.reason : "",
        clean: event.wasClean === true || framed,
      });
    });
  }

  // --- core side: admitted facts update the state machine ------------------

  // A close() before the guest saw `open` aborts the attempt: of the facts
  // still pending for that handle only the close crosses, as close(1006,
  // clean=false), whatever the transport reported before the abort.
  function complete(fact) {
    const conn = connections.get(fact.h);
    if (!conn) return;
    switch (fact.t) {
      case "open":
        if (conn.state === "connecting") {
          conn.state = "open";
          visible.push({ t: "open", h: fact.h, protocol: fact.protocol });
        }
        return;
      case "message":
        conn.received = Math.max(0, conn.received - fact.size - MESSAGE_OVERHEAD_BYTES);
        if (conn.closedBeforeOpen || (conn.state !== "open" && conn.state !== "closing")) return;
        if (fact.text) {
          visible.push({ t: "message", h: fact.h, text: true, data: fact.data });
        } else {
          const message = nextMessage;
          nextMessage = message === 0x7fffffff ? 1 : message + 1;
          staged.set(message, fact.body);
          visible.push({ t: "message", h: fact.h, text: false, m: message, bytes: fact.body.byteLength });
        }
        return;
      case "error":
        if (conn.state !== "closed" && !conn.closedBeforeOpen) {
          visible.push({ t: "error", h: fact.h, code: fact.code, message: fact.message });
        }
        return;
      case "close":
        if (conn.state === "closed") return;
        conn.state = "closed";
        conn.queued = 0;
        conn.sent.length = 0;
        conn.sentBytes = 0;
        visible.push(conn.closedBeforeOpen
          ? { t: "close", h: fact.h, code: CLOSE_ABNORMAL, reason: "", clean: false }
          : { t: "close", h: fact.h, code: fact.code, reason: fact.reason, clean: fact.clean });
        return;
    }
  }

  const ns = {
    open(url, metaJson) {
      if (connections.size >= MAX_CONNECTIONS) {
        return refuse("busy", `at most ${MAX_CONNECTIONS} sockets may be live`);
      }
      if (!isWsUrl(url)) {
        return refuse(
          "invalid_request",
          "url must be absolute ws:// or wss:// with a host and an optional port 1..65535, " +
            `without userinfo or a fragment, at most ${MAX_URL_BYTES} bytes`,
        );
      }
      let meta;
      try {
        meta = JSON.parse(metaJson);
      } catch {
        return refuse("invalid_request", "malformed open metadata");
      }
      if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
          Object.keys(meta).some((key) => key !== "protocols" && key !== "timeoutMs")) {
        return refuse("invalid_request", "malformed open metadata");
      }
      if (!Number.isInteger(meta.timeoutMs) || meta.timeoutMs < 1 || meta.timeoutMs > MAX_TIMEOUT_MS) {
        return refuse("invalid_request", `timeoutMs must be 1..${MAX_TIMEOUT_MS}`);
      }
      const invalidProtocols = protocolError(meta.protocols);
      if (invalidProtocols) return refuse("invalid_request", invalidProtocols);
      if (typeof WebSocketImpl !== "function") {
        return refuse("unavailable", "this browser has no WebSocket");
      }

      const handle = allocateHandle();
      let ws;
      try {
        ws = meta.protocols.length
          ? new WebSocketImpl(url, [...meta.protocols])
          : new WebSocketImpl(url);
      } catch (error) {
        return refuse("invalid_request", error instanceof Error ? error.message : String(error));
      }
      ws.binaryType = "arraybuffer";
      const conn = {
        handle,
        ws,
        state: "connecting",
        queued: 0, // outbound charge, refreshed at beginFrame()
        sent: [], // payload bytes of sent messages not yet known written
        sentBytes: 0, // sum of `sent`
        received: 0, // inbound charge of facts not yet admitted
        opened: false,
        closedBeforeOpen: false,
        done: false,
        timer: undefined,
      };
      conn.timer = setTimeout(() => {
        conn.timer = undefined;
        if (conn.done || conn.opened) return;
        fail(conn, "timeout", `opening handshake exceeded ${meta.timeoutMs} ms`, CLOSE_ABNORMAL);
      }, meta.timeoutMs);
      connections.set(handle, conn);
      attach(conn);
      return handle;
    },
    send(handle, data, isText) {
      const conn = connections.get(handle);
      if (!conn) return refuse("invalid_request", `unknown socket handle ${handle}`);
      if (!(data instanceof ArrayBuffer) || data.detached === true) {
        return refuse("invalid_request", "detached message buffer");
      }
      if (conn.state !== "open") return refuse("closed", "socket is not open");
      if (data.byteLength > MAX_MESSAGE_BYTES) {
        return refuse("message_too_large", `message exceeds ${MAX_MESSAGE_BYTES} bytes`);
      }
      const queued = conn.queued + data.byteLength + MESSAGE_OVERHEAD_BYTES;
      if (queued > MAX_SEND_QUEUE_BYTES) {
        return refuse("backpressure", `${conn.queued} bytes already queued; limit ${MAX_SEND_QUEUE_BYTES}`);
      }
      let payload;
      if (isText) {
        try {
          payload = decoder.decode(data);
        } catch {
          return refuse("invalid_request", "text message is not valid UTF-8");
        }
      } else {
        payload = data.slice(0);
      }
      if (conn.done || conn.ws.readyState !== WS_OPEN) return refuse("closed", "socket is not open");
      try {
        conn.ws.send(payload);
      } catch (error) {
        return refuse("closed", error instanceof Error ? error.message : String(error));
      }
      conn.queued = queued;
      conn.sent.push(data.byteLength);
      conn.sentBytes += data.byteLength;
      return queued;
    },
    close(handle, code, reason) {
      const conn = connections.get(handle);
      if (!conn) return refuse("invalid_request", `unknown socket handle ${handle}`);
      if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) {
        return refuse("invalid_request", "close code must be 1000 or 3000..4999");
      }
      if (typeof reason !== "string" || utf8Bytes(reason) > MAX_CLOSE_REASON_BYTES) {
        return refuse("invalid_request", `close reason exceeds ${MAX_CLOSE_REASON_BYTES} bytes`);
      }
      if (conn.state !== "connecting" && conn.state !== "open") return 0;
      const connecting = conn.state === "connecting";
      conn.state = "closing";
      conn.closedBeforeOpen = connecting;
      if (conn.done) return 0;
      if (connecting) {
        // Abort the attempt, even when the browser already opened it: the
        // guest never saw `open`. The browser would report its own error for
        // this; the guest asked for it, so only the close crosses.
        finish(conn);
        abort(conn);
        completed.push({ t: "close", h: handle, code: CLOSE_ABNORMAL, reason: "", clean: false });
      } else {
        try {
          conn.ws.close(code, reason);
        } catch {
          finish(conn);
          completed.push({ t: "close", h: handle, code: CLOSE_ABNORMAL, reason: "", clean: false });
        }
      }
      return 0;
    },
    poll() {
      polled.clear();
      if (!visible.length) return undefined;
      const swap = polled;
      polled = staged;
      staged = swap;
      const batch = JSON.stringify(visible.splice(0));
      for (const [handle, conn] of connections) {
        if (conn.state === "closed") connections.delete(handle);
      }
      return batch;
    },
    take(messageId, into) {
      const body = polled.get(messageId);
      if (!body || !(into instanceof ArrayBuffer) || into.byteLength !== body.byteLength) return -1;
      new Uint8Array(into).set(body);
      polled.delete(messageId);
      return body.byteLength;
    },
    lastError() {
      return lastError;
    },
  };

  return {
    ns,
    /** Credit written messages and admit at most the per-tick event budget. */
    beginFrame() {
      if (!connections.size) return;
      for (const conn of connections.values()) {
        if (conn.state === "closed") continue;
        const raw = conn.ws.bufferedAmount;
        const buffered = Number.isFinite(raw) && raw > 0 ? raw : 0;
        // The unwritten bytes are the tail of the send order: a message whose
        // successors still cover `buffered` bytes was written in full.
        const { sent } = conn;
        let written = 0;
        while (written < sent.length && conn.sentBytes - sent[written] >= buffered) {
          conn.sentBytes -= sent[written++];
        }
        if (written) sent.splice(0, written);
        conn.queued = buffered + sent.length * MESSAGE_OVERHEAD_BYTES;
      }
      const budget = MAX_EVENTS_PER_TICK - visible.length;
      if (budget <= 0) return;
      for (const fact of completed.splice(0, budget)) complete(fact);
    },
    reset() {
      for (const conn of connections.values()) {
        if (!conn.done) {
          finish(conn);
          abort(conn);
        }
      }
      connections.clear();
      completed.length = 0;
      visible.length = 0;
      staged.clear();
      polled.clear();
      lastError = "";
    },
  };
}
