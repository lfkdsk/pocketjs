//! `pocket-socket` — the transport-neutral core and mounted surface for the
//! PocketJS SOCKET module (`contracts/spec/socket.ts`).
//!
//! This crate owns handles, validation, connection states, outbound queue
//! accounting, the per-tick event budget, received-message ownership and
//! portable errors. It owns no DNS, socket, TLS, HTTP upgrade, WebSocket
//! framing, executor or thread. A runtime supplies a [`SocketTransport`]
//! implemented with the platform facility it already owns (for example
//! tungstenite on a worker thread, a browser `WebSocket`, or a device stack).
//! [`SocketCore::begin_tick`] is the only point at which transport results
//! enter the single-threaded core.
//!
//! Feature `mount` (default) adds [`SocketSurface`], the pocket-mod adapter
//! that installs the six ops as `globalThis.socket`. A host with its own
//! QuickJS wiring turns it off and drives [`SocketCore`] directly.

use std::collections::HashMap;

use pocketjs_core::spec::socket as spec;
use serde::{Deserialize, Serialize};

/// One whole WebSocket message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    Text(String),
    Binary(Vec<u8>),
}

impl Payload {
    pub fn len(&self) -> usize {
        match self {
            Payload::Text(text) => text.len(),
            Payload::Binary(bytes) => bytes.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Fully validated connection request handed to a host-owned transport.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocketOpen {
    pub handle: i32,
    pub url: String,
    pub protocols: Vec<String>,
    /// Bound for connect + TLS + opening handshake.
    pub timeout_ms: u32,
    /// The transport fails the connection (close 1009) above this size.
    pub max_message_bytes: usize,
    /// Received, undelivered charge (payload bytes plus
    /// `SOCKET_MESSAGE_OVERHEAD_BYTES` per message) the transport may hold
    /// per connection.
    pub max_recv_queue_bytes: usize,
}

/// Normalized failure crossing from a host transport into the core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocketFailure {
    pub code: String,
    pub message: String,
}

impl SocketFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: normalize_error_code(&code.into()).to_string(),
            message: message.into(),
        }
    }
}

/// Earlier sends that reached the network since the previous
/// [`SocketTransport::take_sent`] call for a handle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Sent {
    pub messages: usize,
    pub bytes: usize,
}

impl Sent {
    /// Queue charge these sends release: payload bytes plus
    /// `SOCKET_MESSAGE_OVERHEAD_BYTES` per message.
    pub fn charge(self) -> usize {
        self.bytes + self.messages * spec::MESSAGE_OVERHEAD_BYTES
    }
}

/// A transport result. Results of one handle must keep wire order, and each
/// opened handle must end with exactly one `Closed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SocketCompletion {
    Open {
        handle: i32,
        protocol: String,
    },
    Message {
        handle: i32,
        payload: Payload,
    },
    Error {
        handle: i32,
        failure: SocketFailure,
    },
    Closed {
        handle: i32,
        code: u16,
        reason: String,
        clean: bool,
    },
}

/// The only host-specific boundary in the reference implementation.
///
/// `open`, `send` and `close` must return promptly after handing work to a
/// worker or native async mechanism. `take_sent` and `drain` are called at a
/// host tick boundary and must not block. No method may call into QuickJS.
pub trait SocketTransport {
    fn open(&mut self, request: SocketOpen) -> std::result::Result<(), SocketFailure>;
    /// Queue one whole message. The core has already applied the outbound
    /// queue bound; a transport may still refuse (for example when closed).
    fn send(&mut self, handle: i32, payload: Payload) -> std::result::Result<(), SocketFailure>;
    /// Start the closing handshake, or abort a connection still opening.
    fn close(&mut self, handle: i32, code: u16, reason: String);
    /// Whole messages (and their payload bytes) of earlier sends written to
    /// the network since the previous call for this handle.
    fn take_sent(&mut self, handle: i32) -> Sent;
    /// Move at most `max` results, in transport order, without blocking.
    /// Results left behind stay in the transport's bounded queue, which is
    /// where inbound back-pressure starts.
    fn drain(&mut self, completions: &mut Vec<SocketCompletion>, max: usize);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenMeta {
    protocols: Vec<String>,
    timeout_ms: u32,
}

#[derive(Serialize)]
#[serde(tag = "t")]
enum GuestEvent {
    #[serde(rename = "open")]
    Open {
        #[serde(rename = "h")]
        handle: i32,
        protocol: String,
    },
    #[serde(rename = "message")]
    Text {
        #[serde(rename = "h")]
        handle: i32,
        text: bool,
        data: String,
    },
    #[serde(rename = "message")]
    Binary {
        #[serde(rename = "h")]
        handle: i32,
        text: bool,
        #[serde(rename = "m")]
        message: i32,
        bytes: usize,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "h")]
        handle: i32,
        code: String,
        message: String,
    },
    #[serde(rename = "close")]
    Close {
        #[serde(rename = "h")]
        handle: i32,
        code: u16,
        reason: String,
        clean: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Connecting,
    Open,
    Closing,
    /// Terminal event staged; the handle is released by the next poll().
    Closed,
}

struct Connection {
    state: State,
    /// Outbound charge not yet credited by `take_sent`.
    queued: usize,
    /// close() arrived before `open`: the attempt ends with close only.
    aborted: bool,
}

/// Transport-neutral SOCKET state machine. Independent of QuickJS;
/// [`SocketSurface`] below is only the namespace adapter.
pub struct SocketCore<T: SocketTransport> {
    transport: T,
    connections: HashMap<i32, Connection>,
    visible: Vec<GuestEvent>,
    /// Binary bodies of events staged for the next poll().
    staged_bodies: HashMap<i32, Vec<u8>>,
    /// Binary bodies of the batch most recently returned by poll().
    polled_bodies: HashMap<i32, Vec<u8>>,
    next_handle: i32,
    next_message: i32,
    last_error: String,
    scratch: Vec<SocketCompletion>,
}

impl<T: SocketTransport> SocketCore<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            connections: HashMap::new(),
            visible: Vec::new(),
            staged_bodies: HashMap::new(),
            polled_bodies: HashMap::new(),
            next_handle: 1,
            next_message: 1,
            last_error: String::new(),
            scratch: Vec::new(),
        }
    }

    /// Mutable transport access for host wiring and tests.
    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    /// Live handles, including handles whose close event is not yet polled.
    pub fn live(&self) -> usize {
        self.connections.len()
    }

    fn refuse(&mut self, failure: SocketFailure) -> i32 {
        self.last_error = format!("{}: {}", failure.code, failure.message);
        -1
    }

    pub fn open(&mut self, url: &str, meta_json: &str) -> i32 {
        match self.try_open(url, meta_json) {
            Ok(handle) => handle,
            Err(failure) => self.refuse(failure),
        }
    }

    fn try_open(&mut self, url: &str, meta_json: &str) -> std::result::Result<i32, SocketFailure> {
        if self.connections.len() >= spec::MAX_CONNECTIONS {
            return Err(SocketFailure::new(
                spec::ERROR_BUSY,
                format!("at most {} sockets may be live", spec::MAX_CONNECTIONS),
            ));
        }
        if !is_ws_url(url) {
            return Err(invalid(format!(
                "url must be absolute ws:// or wss:// with a host and an optional port \
                 1..65535, without userinfo or a fragment, at most {} bytes",
                spec::MAX_URL_BYTES
            )));
        }
        let meta: OpenMeta =
            serde_json::from_str(meta_json).map_err(|_| invalid("malformed open metadata"))?;
        if meta.timeout_ms == 0 || meta.timeout_ms > spec::MAX_TIMEOUT_MS {
            return Err(invalid(format!(
                "timeoutMs must be 1..{}",
                spec::MAX_TIMEOUT_MS
            )));
        }
        validate_protocols(&meta.protocols)?;

        let handle = self.allocate_handle();
        let request = SocketOpen {
            handle,
            url: url.to_string(),
            protocols: meta.protocols,
            timeout_ms: meta.timeout_ms,
            max_message_bytes: spec::MAX_MESSAGE_BYTES,
            max_recv_queue_bytes: spec::MAX_RECV_QUEUE_BYTES,
        };
        self.connections.insert(
            handle,
            Connection {
                state: State::Connecting,
                queued: 0,
                aborted: false,
            },
        );
        if let Err(failure) = self.transport.open(request) {
            self.connections.remove(&handle);
            return Err(failure);
        }
        Ok(handle)
    }

    fn allocate_handle(&mut self) -> i32 {
        loop {
            let handle = self.next_handle;
            self.next_handle = if handle == i32::MAX { 1 } else { handle + 1 };
            if !self.connections.contains_key(&handle) {
                return handle;
            }
        }
    }

    /// Queue one message. Returns the connection's queued outbound charge
    /// including this message, or -1 with lastError set.
    pub fn send(&mut self, handle: i32, data: &[u8], is_text: bool) -> i64 {
        match self.try_send(handle, data, is_text) {
            Ok(queued) => queued as i64,
            Err(failure) => self.refuse(failure) as i64,
        }
    }

    fn try_send(
        &mut self,
        handle: i32,
        data: &[u8],
        is_text: bool,
    ) -> std::result::Result<usize, SocketFailure> {
        let Some(connection) = self.connections.get(&handle) else {
            return Err(invalid(format!("unknown socket handle {handle}")));
        };
        if connection.state != State::Open {
            return Err(SocketFailure::new(spec::ERROR_CLOSED, "socket is not open"));
        }
        if data.len() > spec::MAX_MESSAGE_BYTES {
            return Err(SocketFailure::new(
                spec::ERROR_MESSAGE_TOO_LARGE,
                format!("message exceeds {} bytes", spec::MAX_MESSAGE_BYTES),
            ));
        }
        let queued = connection.queued + data.len() + spec::MESSAGE_OVERHEAD_BYTES;
        if queued > spec::MAX_SEND_QUEUE_BYTES {
            return Err(SocketFailure::new(
                spec::ERROR_BACKPRESSURE,
                format!(
                    "{} bytes already queued; limit {}",
                    connection.queued,
                    spec::MAX_SEND_QUEUE_BYTES
                ),
            ));
        }
        let payload = if is_text {
            Payload::Text(
                String::from_utf8(data.to_vec())
                    .map_err(|_| invalid("text message is not valid UTF-8"))?,
            )
        } else {
            Payload::Binary(data.to_vec())
        };
        self.transport.send(handle, payload)?;
        self.connections
            .get_mut(&handle)
            .expect("checked above")
            .queued = queued;
        Ok(queued)
    }

    pub fn close(&mut self, handle: i32, code: i32, reason: &str) -> i32 {
        let Some(connection) = self.connections.get(&handle) else {
            return self.refuse(invalid(format!("unknown socket handle {handle}")));
        };
        if code != i32::from(spec::CLOSE_NORMAL) && !(3000..=4999).contains(&code) {
            return self.refuse(invalid("close code must be 1000 or 3000..4999"));
        }
        if reason.len() > spec::MAX_CLOSE_REASON_BYTES {
            return self.refuse(invalid(format!(
                "close reason exceeds {} bytes",
                spec::MAX_CLOSE_REASON_BYTES
            )));
        }
        match connection.state {
            State::Connecting | State::Open => {
                let connection = self.connections.get_mut(&handle).expect("checked above");
                connection.aborted = connection.state == State::Connecting;
                connection.state = State::Closing;
                self.transport
                    .close(handle, code as u16, reason.to_string());
            }
            State::Closing | State::Closed => {}
        }
        0
    }

    /// Credit written bytes and admit at most the per-tick event budget from
    /// the transport. Call before the corresponding guest `frame()`.
    pub fn begin_tick(&mut self) {
        if self.connections.is_empty() {
            return;
        }
        for (handle, connection) in self.connections.iter_mut() {
            if connection.queued > 0 {
                let sent = self.transport.take_sent(*handle).charge();
                connection.queued = connection.queued.saturating_sub(sent);
            }
        }
        let budget = spec::MAX_EVENTS_PER_TICK.saturating_sub(self.visible.len());
        if budget == 0 {
            return;
        }
        let mut completions = std::mem::take(&mut self.scratch);
        self.transport.drain(&mut completions, budget);
        for completion in completions.drain(..) {
            self.complete(completion);
        }
        self.scratch = completions;
    }

    fn complete(&mut self, completion: SocketCompletion) {
        match completion {
            SocketCompletion::Open { handle, protocol } => {
                let Some(connection) = self.connections.get_mut(&handle) else {
                    return;
                };
                if connection.state == State::Connecting {
                    connection.state = State::Open;
                    self.visible.push(GuestEvent::Open { handle, protocol });
                }
            }
            SocketCompletion::Message { handle, payload } => {
                let Some(connection) = self.connections.get_mut(&handle) else {
                    return;
                };
                if !matches!(connection.state, State::Open | State::Closing) || connection.aborted {
                    return;
                }
                if payload.len() > spec::MAX_MESSAGE_BYTES {
                    // A transport that let an oversized message through is
                    // corrected here: no body crosses, the connection fails.
                    if connection.state == State::Open {
                        connection.state = State::Closing;
                        self.transport.close(
                            handle,
                            spec::CLOSE_MESSAGE_TOO_BIG,
                            "message too big".into(),
                        );
                    }
                    self.visible.push(GuestEvent::Error {
                        handle,
                        code: spec::ERROR_MESSAGE_TOO_LARGE.into(),
                        message: format!("message exceeds {} bytes", spec::MAX_MESSAGE_BYTES),
                    });
                    return;
                }
                match payload {
                    Payload::Text(data) => self.visible.push(GuestEvent::Text {
                        handle,
                        text: true,
                        data,
                    }),
                    Payload::Binary(body) => {
                        let message = self.next_message;
                        self.next_message = if message == i32::MAX { 1 } else { message + 1 };
                        self.visible.push(GuestEvent::Binary {
                            handle,
                            text: false,
                            message,
                            bytes: body.len(),
                        });
                        self.staged_bodies.insert(message, body);
                    }
                }
            }
            SocketCompletion::Error { handle, failure } => {
                let Some(connection) = self.connections.get(&handle) else {
                    return;
                };
                // A guest that aborted its own connect sees only the close.
                if connection.state == State::Closed || connection.aborted {
                    return;
                }
                self.visible.push(GuestEvent::Error {
                    handle,
                    code: normalize_error_code(&failure.code).into(),
                    message: failure.message,
                });
            }
            SocketCompletion::Closed {
                handle,
                code,
                reason,
                clean,
            } => {
                let Some(connection) = self.connections.get_mut(&handle) else {
                    return;
                };
                if connection.state == State::Closed {
                    return;
                }
                connection.state = State::Closed;
                connection.queued = 0;
                // An aborted connect ends the same way on every transport,
                // even when the handshake finished before the abort.
                let (code, reason, clean) = if connection.aborted {
                    (spec::CLOSE_ABNORMAL, String::new(), false)
                } else {
                    (code, reason, clean)
                };
                self.visible.push(GuestEvent::Close {
                    handle,
                    code,
                    reason,
                    clean,
                });
            }
        }
    }

    /// Drain the whole tick batch in one serialization and one FFI crossing.
    /// Bodies of the previous batch that were never taken are dropped here,
    /// and handles whose close event this batch carries are released.
    pub fn poll(&mut self) -> Option<String> {
        self.polled_bodies.clear();
        if self.visible.is_empty() {
            return None;
        }
        std::mem::swap(&mut self.polled_bodies, &mut self.staged_bodies);
        let events = std::mem::take(&mut self.visible);
        self.connections
            .retain(|_, connection| connection.state != State::Closed);
        Some(serde_json::to_string(&events).expect("GuestEvent serialization is infallible"))
    }

    pub fn take(&mut self, message: i32) -> Option<Vec<u8>> {
        self.polled_bodies.remove(&message)
    }

    pub fn take_into(&mut self, message: i32, into: &mut [u8]) -> i32 {
        let Some(body) = self.polled_bodies.get(&message) else {
            return -1;
        };
        if body.len() != into.len() {
            return -1;
        }
        into.copy_from_slice(body);
        self.polled_bodies.remove(&message);
        into.len() as i32
    }

    pub fn last_error(&self) -> &str {
        &self.last_error
    }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

#[cfg(feature = "mount")]
use std::cell::RefCell;
#[cfg(feature = "mount")]
use std::rc::Rc;

#[cfg(feature = "mount")]
use anyhow::Result;
#[cfg(feature = "mount")]
use pocket_mod::Guest;
#[cfg(feature = "mount")]
use pocket_mod::qjs::{ArrayBuffer, Function};

/// Clone-cheap mounted SOCKET module. The host keeps a copy and calls
/// [`begin_tick`](Self::begin_tick); the namespace closures share the core.
#[cfg(feature = "mount")]
pub struct SocketSurface<T: SocketTransport> {
    inner: Rc<RefCell<SocketCore<T>>>,
}

#[cfg(feature = "mount")]
impl<T: SocketTransport> Clone for SocketSurface<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

#[cfg(feature = "mount")]
impl<T: SocketTransport + 'static> SocketSurface<T> {
    pub fn new(transport: T) -> Self {
        Self {
            inner: Rc::new(RefCell::new(SocketCore::new(transport))),
        }
    }

    pub fn begin_tick(&self) {
        self.inner.borrow_mut().begin_tick();
    }

    pub fn with_core<R>(&self, f: impl FnOnce(&mut SocketCore<T>) -> R) -> R {
        f(&mut self.inner.borrow_mut())
    }

    /// Mount exactly the six ops pinned in `contracts/spec/socket.ts`.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("socket", |ctx, ns| {
            let core = self.inner.clone();
            ns.set(
                "open",
                Function::new(ctx.clone(), move |url: String, meta: String| {
                    core.borrow_mut().open(&url, &meta)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "send",
                Function::new(
                    ctx.clone(),
                    move |handle: i32, data: ArrayBuffer, is_text: bool| -> f64 {
                        let Some(bytes) = data.as_bytes() else {
                            let mut core = core.borrow_mut();
                            core.last_error =
                                format!("{}: detached message buffer", spec::ERROR_INVALID_REQUEST);
                            return -1.0;
                        };
                        core.borrow_mut().send(handle, bytes, is_text) as f64
                    },
                )?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "close",
                Function::new(
                    ctx.clone(),
                    move |handle: i32, code: i32, reason: String| {
                        core.borrow_mut().close(handle, code, &reason)
                    },
                )?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "poll",
                Function::new(ctx.clone(), move || core.borrow_mut().poll())?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "take",
                Function::new(ctx.clone(), move |message: i32, into: ArrayBuffer| {
                    let Some(raw) = into.as_raw() else {
                        return -1;
                    };
                    // QuickJS owns this mutable ArrayBuffer for the duration
                    // of the synchronous call (the pocket-net take pattern).
                    let bytes =
                        unsafe { std::slice::from_raw_parts_mut(raw.ptr.as_ptr(), raw.len) };
                    core.borrow_mut().take_into(message, bytes)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "lastError",
                Function::new(ctx.clone(), move || core.borrow().last_error().to_string())?,
            )?;
            Ok(())
        })
    }
}

fn invalid(message: impl Into<String>) -> SocketFailure {
    SocketFailure::new(spec::ERROR_INVALID_REQUEST, message)
}

/// Absolute ws:// or wss:// URL within the portable length: no whitespace,
/// control bytes or fragment (RFC 6455 §3); every `%` followed by two hex
/// digits; an ASCII authority without userinfo and an optional decimal port
/// 1..65535. The host is a bracketed RFC 3986 IPv6 literal without a zone id,
/// a dotted-decimal IPv4 address, or a reg-name without `%` whose last label
/// is not numeric (WHATWG URL parses such a host as IPv4).
pub fn is_ws_url(url: &str) -> bool {
    if url.len() > spec::MAX_URL_BYTES {
        return false;
    }
    let Some(rest) = url
        .strip_prefix("ws://")
        .or_else(|| url.strip_prefix("wss://"))
    else {
        return false;
    };
    if rest.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'#') || !is_percent_encoded(rest) {
        return false;
    }
    let end = rest.find(['/', '?']).unwrap_or(rest.len());
    is_authority(&rest[..end])
}

fn is_percent_encoded(text: &str) -> bool {
    let bytes = text.as_bytes();
    let hex = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_hexdigit);
    (0..bytes.len()).all(|i| bytes[i] != b'%' || (hex(i + 1) && hex(i + 2)))
}

fn is_authority(authority: &str) -> bool {
    let (host, port) = if let Some(literal) = authority.strip_prefix('[') {
        let Some((inner, after)) = literal.split_once(']') else {
            return false;
        };
        match after.strip_prefix(':') {
            Some(port) => (is_ipv6(inner), Some(port)),
            None if after.is_empty() => (is_ipv6(inner), None),
            None => return false,
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (is_host_name(host), Some(port)),
            None => (is_host_name(authority), None),
        }
    };
    host && match port {
        None => true,
        Some(port) => {
            (1..=5).contains(&port.len())
                && port.bytes().all(|b| b.is_ascii_digit())
                && matches!(port.parse::<u32>(), Ok(1..=65535))
        }
    }
}

fn is_host_name(host: &str) -> bool {
    let reg_name = |b: u8| {
        b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
            )
    };
    if host.is_empty() || !host.bytes().all(reg_name) {
        return false;
    }
    let mut labels = host.rsplit('.');
    let mut last = labels.next().unwrap_or_default();
    if last.is_empty()
        && let Some(previous) = labels.next()
    {
        last = previous;
    }
    let numeric = (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
        || last
            .strip_prefix("0x")
            .or_else(|| last.strip_prefix("0X"))
            .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()));
    !numeric || is_ipv4(host)
}

/// Four decimal parts 0..255 without leading zeros.
fn is_ipv4(text: &str) -> bool {
    text.split('.').count() == 4
        && text.split('.').all(|part| {
            part.bytes().all(|b| b.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
                && part.parse::<u8>().is_ok()
        })
}

/// RFC 3986 IPv6address: 1-4 hex digits per group, at most one `::` standing
/// for one or more zero groups, and an optional IPv4 tail counted as two
/// groups.
fn is_ipv6(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut compressed = text.starts_with("::");
    let mut i = if compressed { 2 } else { 0 };
    let mut groups = 0;
    while i < bytes.len() {
        let digits = bytes[i..]
            .iter()
            .take_while(|b| b.is_ascii_hexdigit())
            .count();
        let j = i + digits;
        if bytes.get(j) == Some(&b'.') {
            if !is_ipv4(&text[i..]) {
                return false;
            }
            groups += 2;
            break;
        }
        if !(1..=4).contains(&digits) {
            return false;
        }
        groups += 1;
        match bytes.get(j) {
            None => break,
            Some(b':') => i = j + 1,
            Some(_) => return false,
        }
        if bytes.get(i) == Some(&b':') {
            if compressed {
                return false;
            }
            compressed = true;
            i += 1;
        } else if i == bytes.len() {
            return false;
        }
    }
    if compressed { groups <= 7 } else { groups == 8 }
}

fn is_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn validate_protocols(protocols: &[String]) -> std::result::Result<(), SocketFailure> {
    let bytes: usize = protocols.iter().map(String::len).sum();
    if protocols.len() > spec::MAX_PROTOCOLS || bytes > spec::MAX_PROTOCOL_BYTES {
        return Err(invalid(format!(
            "at most {} protocols of {} bytes in total",
            spec::MAX_PROTOCOLS,
            spec::MAX_PROTOCOL_BYTES
        )));
    }
    for (i, protocol) in protocols.iter().enumerate() {
        if !is_token(protocol) {
            return Err(invalid(format!("invalid protocol {protocol:?}")));
        }
        if protocols[..i].contains(protocol) {
            return Err(invalid(format!("duplicate protocol {protocol:?}")));
        }
    }
    Ok(())
}

fn normalize_error_code(code: &str) -> &'static str {
    match code {
        spec::ERROR_UNAVAILABLE => spec::ERROR_UNAVAILABLE,
        spec::ERROR_INVALID_REQUEST => spec::ERROR_INVALID_REQUEST,
        spec::ERROR_BUSY => spec::ERROR_BUSY,
        spec::ERROR_CLOSED => spec::ERROR_CLOSED,
        spec::ERROR_BACKPRESSURE => spec::ERROR_BACKPRESSURE,
        spec::ERROR_DNS => spec::ERROR_DNS,
        spec::ERROR_CONNECT => spec::ERROR_CONNECT,
        spec::ERROR_TLS => spec::ERROR_TLS,
        spec::ERROR_TIMEOUT => spec::ERROR_TIMEOUT,
        spec::ERROR_HANDSHAKE => spec::ERROR_HANDSHAKE,
        spec::ERROR_MESSAGE_TOO_LARGE => spec::ERROR_MESSAGE_TOO_LARGE,
        spec::ERROR_OVERFLOW => spec::ERROR_OVERFLOW,
        spec::ERROR_PROTOCOL => spec::ERROR_PROTOCOL,
        _ => spec::ERROR_OTHER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct FixtureTransport {
        opened: Vec<SocketOpen>,
        sent: Vec<(i32, Payload)>,
        closed: Vec<(i32, u16, String)>,
        written: HashMap<i32, Sent>,
        results: VecDeque<SocketCompletion>,
        drained_with: Vec<usize>,
    }

    impl SocketTransport for FixtureTransport {
        fn open(&mut self, request: SocketOpen) -> std::result::Result<(), SocketFailure> {
            self.opened.push(request);
            Ok(())
        }
        fn send(
            &mut self,
            handle: i32,
            payload: Payload,
        ) -> std::result::Result<(), SocketFailure> {
            self.sent.push((handle, payload));
            Ok(())
        }
        fn close(&mut self, handle: i32, code: u16, reason: String) {
            self.closed.push((handle, code, reason));
        }
        fn take_sent(&mut self, handle: i32) -> Sent {
            self.written.remove(&handle).unwrap_or_default()
        }
        fn drain(&mut self, completions: &mut Vec<SocketCompletion>, max: usize) {
            self.drained_with.push(max);
            let n = max.min(self.results.len());
            completions.extend(self.results.drain(..n));
        }
    }

    const META: &str = r#"{"protocols":[],"timeoutMs":10000}"#;

    fn opened(core: &mut SocketCore<FixtureTransport>) -> i32 {
        let handle = core.open("ws://example.test/ws", META);
        assert!(handle > 0, "{}", core.last_error());
        core.transport_mut()
            .results
            .push_back(SocketCompletion::Open {
                handle,
                protocol: String::new(),
            });
        core.begin_tick();
        assert_eq!(
            core.poll().unwrap(),
            format!(r#"[{{"t":"open","h":{handle},"protocol":""}}]"#)
        );
        handle
    }

    #[test]
    fn results_are_visible_only_after_the_tick_boundary() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = core.open("wss://example.test/a?b=1", META);
        assert_eq!(handle, 1);
        assert_eq!(
            core.transport_mut().opened[0].url,
            "wss://example.test/a?b=1"
        );
        core.transport_mut().results.extend([
            SocketCompletion::Open {
                handle,
                protocol: "zone".into(),
            },
            SocketCompletion::Message {
                handle,
                payload: Payload::Text("hi".into()),
            },
            SocketCompletion::Message {
                handle,
                payload: Payload::Binary(vec![1, 2, 3]),
            },
        ]);
        assert!(core.poll().is_none());
        core.begin_tick();
        assert_eq!(
            core.poll().unwrap(),
            r#"[{"t":"open","h":1,"protocol":"zone"},{"t":"message","h":1,"text":true,"data":"hi"},{"t":"message","h":1,"text":false,"m":1,"bytes":3}]"#
        );
        let mut wrong = [0u8; 2];
        assert_eq!(core.take_into(1, &mut wrong), -1);
        let mut into = [0u8; 3];
        assert_eq!(core.take_into(1, &mut into), 3);
        assert_eq!(into, [1, 2, 3]);
        assert_eq!(core.take_into(1, &mut into), -1);
    }

    #[test]
    fn untaken_bodies_are_dropped_by_the_next_poll() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = opened(&mut core);
        core.transport_mut()
            .results
            .push_back(SocketCompletion::Message {
                handle,
                payload: Payload::Binary(vec![9; 4]),
            });
        core.begin_tick();
        assert!(core.poll().unwrap().contains(r#""m":1"#));
        assert!(core.poll().is_none());
        assert!(core.take(1).is_none());
    }

    #[test]
    fn validates_urls_meta_and_protocols_synchronously() {
        let mut core = SocketCore::new(FixtureTransport::default());
        for url in [
            "http://example.test/",
            "ws://",
            "ws:///path",
            "ws://host/a#frag",
            "ws://host/a b",
            "wss:example.test",
        ] {
            assert_eq!(core.open(url, META), -1, "{url}");
            assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        }
        let long = format!("ws://h/{}", "a".repeat(spec::MAX_URL_BYTES));
        assert_eq!(core.open(&long, META), -1);
        assert_eq!(core.open("ws://h/", "{}"), -1);
        assert_eq!(
            core.open("ws://h/", r#"{"protocols":[],"timeoutMs":0}"#),
            -1
        );
        assert_eq!(
            core.open("ws://h/", r#"{"protocols":["a b"],"timeoutMs":10}"#),
            -1
        );
        assert_eq!(
            core.open("ws://h/", r#"{"protocols":["a","a"],"timeoutMs":10}"#),
            -1
        );
        assert_eq!(
            core.open("ws://h/", r#"{"protocols":[],"timeoutMs":10,"headers":{}}"#),
            -1
        );
        assert!(core.transport_mut().opened.is_empty());
        assert!(core.open("ws://h/", r#"{"protocols":["zone.v1"],"timeoutMs":10}"#) > 0);
    }

    #[test]
    fn connection_limit_counts_handles_until_their_close_is_polled() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handles: Vec<i32> = (0..spec::MAX_CONNECTIONS)
            .map(|_| core.open("ws://h/", META))
            .collect();
        assert!(handles.iter().all(|h| *h > 0));
        assert_eq!(core.open("ws://h/", META), -1);
        assert!(core.last_error().starts_with(spec::ERROR_BUSY));
        core.transport_mut()
            .results
            .push_back(SocketCompletion::Closed {
                handle: handles[0],
                code: spec::CLOSE_ABNORMAL,
                reason: String::new(),
                clean: false,
            });
        core.begin_tick();
        assert_eq!(core.open("ws://h/", META), -1, "close not yet polled");
        assert!(core.poll().unwrap().contains(r#""code":1006"#));
        assert!(core.open("ws://h/", META) > 0);
    }

    #[test]
    fn send_is_refused_until_open_and_bounded_by_the_queue() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let pending = core.open("ws://h/", META);
        assert_eq!(core.send(pending, b"x", false), -1);
        assert!(core.last_error().starts_with(spec::ERROR_CLOSED));

        let handle = opened(&mut core);
        let overhead = spec::MESSAGE_OVERHEAD_BYTES;
        let big = vec![0u8; spec::MAX_MESSAGE_BYTES - overhead];
        let mut queued = 0;
        for _ in 0..spec::MAX_SEND_QUEUE_BYTES / spec::MAX_MESSAGE_BYTES {
            queued = core.send(handle, &big, false);
        }
        assert_eq!(queued as usize, spec::MAX_SEND_QUEUE_BYTES);
        assert_eq!(core.send(handle, b"", false), -1);
        assert!(core.last_error().starts_with(spec::ERROR_BACKPRESSURE));
        // Written messages are credited back at the next tick boundary.
        core.transport_mut().written.insert(
            handle,
            Sent {
                messages: 1,
                bytes: big.len(),
            },
        );
        assert_eq!(core.send(handle, b"x", false), -1);
        core.begin_tick();
        assert_eq!(
            core.send(handle, b"x", true) as usize,
            spec::MAX_SEND_QUEUE_BYTES - spec::MAX_MESSAGE_BYTES + 1 + overhead
        );
        let oversized = vec![0u8; spec::MAX_MESSAGE_BYTES + 1];
        assert_eq!(core.send(handle, &oversized, false), -1);
        assert!(core.last_error().starts_with(spec::ERROR_MESSAGE_TOO_LARGE));
        assert_eq!(core.send(handle, &[0xff], true), -1);
        assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        assert_eq!(
            core.transport_mut().sent.last(),
            Some(&(handle, Payload::Text("x".into())))
        );
    }

    #[test]
    fn empty_messages_are_charged_against_the_send_queue() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = opened(&mut core);
        let limit = spec::MAX_SEND_QUEUE_BYTES / spec::MESSAGE_OVERHEAD_BYTES;
        let mut accepted = 0;
        for _ in 0..100_000 {
            if core.send(handle, &[], false) >= 0 {
                accepted += 1;
            }
        }
        assert_eq!(accepted, limit);
        assert!(core.last_error().starts_with(spec::ERROR_BACKPRESSURE));
        assert_eq!(core.transport_mut().sent.len(), limit);
        core.transport_mut().written.insert(
            handle,
            Sent {
                messages: limit,
                bytes: 0,
            },
        );
        core.begin_tick();
        assert_eq!(
            core.send(handle, &[], true) as usize,
            spec::MESSAGE_OVERHEAD_BYTES
        );
    }

    #[test]
    fn close_before_open_reports_only_the_close() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = core.open("ws://h/", META);
        assert_eq!(core.close(handle, 1000, "cancel"), 0);
        core.transport_mut().results.extend([
            SocketCompletion::Error {
                handle,
                failure: SocketFailure::new(spec::ERROR_CONNECT, "closed before open"),
            },
            SocketCompletion::Closed {
                handle,
                code: spec::CLOSE_ABNORMAL,
                reason: String::new(),
                clean: false,
            },
        ]);
        core.begin_tick();
        assert_eq!(
            core.poll().unwrap(),
            format!(r#"[{{"t":"close","h":{handle},"code":1006,"reason":"","clean":false}}]"#)
        );
        // The handshake finished before the abort reached the transport:
        // its open, messages and clean close stay hidden behind 1006.
        let handle = core.open("ws://h/", META);
        assert_eq!(core.close(handle, 1000, ""), 0);
        core.transport_mut().results.extend([
            SocketCompletion::Open {
                handle,
                protocol: String::new(),
            },
            SocketCompletion::Message {
                handle,
                payload: Payload::Text("early".into()),
            },
            SocketCompletion::Closed {
                handle,
                code: 1000,
                reason: String::new(),
                clean: true,
            },
        ]);
        core.begin_tick();
        assert_eq!(
            core.poll().unwrap(),
            format!(r#"[{{"t":"close","h":{handle},"code":1006,"reason":"","clean":false}}]"#)
        );
        // A failure of an opened connection still reports its error.
        let handle = opened(&mut core);
        assert_eq!(core.close(handle, 1000, ""), 0);
        core.transport_mut()
            .results
            .push_back(SocketCompletion::Error {
                handle,
                failure: SocketFailure::new(spec::ERROR_TIMEOUT, "no close answer"),
            });
        core.begin_tick();
        assert!(core.poll().unwrap().contains(r#""t":"error""#));
    }

    #[test]
    fn malformed_authorities_are_refused_before_the_transport() {
        let mut core = SocketCore::new(FixtureTransport::default());
        for url in [
            "ws://:",
            "ws://:80",
            "ws://h:",
            "ws://h:0",
            "ws://h:65536",
            "ws://h:8a",
            "ws://u@h",
            "ws://[]",
            "ws://[zz]",
            "ws://[::1]x",
            "ws:///p",
            "ws://?q",
            "ws://h#f",
            "ws://hé/",
            "ws://h:123456",
        ] {
            assert_eq!(core.open(url, META), -1, "{url}");
            assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        }
        assert!(core.transport_mut().opened.is_empty());
        for url in [
            "ws://h",
            "wss://h:443/p?q=1",
            "ws://127.0.0.1:8080/x",
            "ws://[::1]:9000/",
            "ws://a-b.c_d~e",
            "ws://h?q",
        ] {
            let handle = core.open(url, META);
            assert!(handle > 0, "{url}: {}", core.last_error());
            core.close(handle, 1000, "");
            core.transport_mut()
                .results
                .push_back(SocketCompletion::Closed {
                    handle,
                    code: spec::CLOSE_ABNORMAL,
                    reason: String::new(),
                    clean: false,
                });
            core.begin_tick();
            core.poll();
        }
    }

    #[test]
    fn shared_url_table_is_decided_before_the_transport() {
        let table: serde_json::Value =
            serde_json::from_str(include_str!("../../../../tests/fixtures/socket-urls.json"))
                .unwrap();
        let urls =
            |key: &str| -> Vec<String> { serde_json::from_value(table[key].clone()).unwrap() };
        let mut core = SocketCore::new(FixtureTransport::default());
        for url in urls("invalid") {
            assert!(!is_ws_url(&url), "{url}");
            assert_eq!(core.open(&url, META), -1, "{url}");
            assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        }
        assert!(core.transport_mut().opened.is_empty());
        for url in urls("valid") {
            assert!(is_ws_url(&url), "{url}");
            let handle = core.open(&url, META);
            assert!(handle > 0, "{url}: {}", core.last_error());
            core.close(handle, 1000, "");
            core.transport_mut()
                .results
                .push_back(SocketCompletion::Closed {
                    handle,
                    code: spec::CLOSE_ABNORMAL,
                    reason: String::new(),
                    clean: false,
                });
            core.begin_tick();
            core.poll();
        }
    }

    #[test]
    fn per_tick_event_budget_leaves_the_rest_in_the_transport() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = opened(&mut core);
        for i in 0..spec::MAX_EVENTS_PER_TICK + 10 {
            core.transport_mut()
                .results
                .push_back(SocketCompletion::Message {
                    handle,
                    payload: Payload::Text(i.to_string()),
                });
        }
        core.begin_tick();
        let first: Vec<serde_json::Value> = serde_json::from_str(&core.poll().unwrap()).unwrap();
        assert_eq!(first.len(), spec::MAX_EVENTS_PER_TICK);
        assert_eq!(core.transport_mut().results.len(), 10);
        // A guest that skips poll() cannot grow the staged batch.
        core.begin_tick();
        core.begin_tick();
        let second: Vec<serde_json::Value> = serde_json::from_str(&core.poll().unwrap()).unwrap();
        assert_eq!(second.len(), 10);
        assert_eq!(second[0]["data"], spec::MAX_EVENTS_PER_TICK.to_string());
    }

    #[test]
    fn close_validates_and_ends_with_exactly_one_close_event() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = opened(&mut core);
        assert_eq!(core.close(handle, 1001, ""), -1);
        assert_eq!(core.close(handle, 1000, &"r".repeat(124)), -1);
        assert_eq!(core.close(handle, 4000, "bye"), 0);
        assert_eq!(core.close(handle, 4000, "again"), 0);
        assert_eq!(
            core.transport_mut().closed,
            vec![(handle, 4000, "bye".to_string())]
        );
        assert_eq!(core.send(handle, b"late", false), -1);
        core.transport_mut().results.extend([
            SocketCompletion::Message {
                handle,
                payload: Payload::Text("in flight".into()),
            },
            SocketCompletion::Closed {
                handle,
                code: 4000,
                reason: "bye".into(),
                clean: true,
            },
            SocketCompletion::Closed {
                handle,
                code: 1006,
                reason: String::new(),
                clean: false,
            },
        ]);
        core.begin_tick();
        assert_eq!(
            core.poll().unwrap(),
            format!(
                r#"[{{"t":"message","h":{handle},"text":true,"data":"in flight"}},{{"t":"close","h":{handle},"code":4000,"reason":"bye","clean":true}}]"#
            )
        );
        assert_eq!(core.live(), 0);
        assert_eq!(core.close(handle, 1000, ""), -1);
    }

    #[test]
    fn oversized_inbound_message_fails_the_connection_without_a_body() {
        let mut core = SocketCore::new(FixtureTransport::default());
        let handle = opened(&mut core);
        core.transport_mut()
            .results
            .push_back(SocketCompletion::Message {
                handle,
                payload: Payload::Binary(vec![0; spec::MAX_MESSAGE_BYTES + 1]),
            });
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert!(batch.contains(spec::ERROR_MESSAGE_TOO_LARGE), "{batch}");
        assert_eq!(
            core.transport_mut().closed,
            vec![(
                handle,
                spec::CLOSE_MESSAGE_TOO_BIG,
                "message too big".into()
            )]
        );
    }

    #[test]
    fn idle_tick_does_not_touch_the_transport() {
        let mut core = SocketCore::new(FixtureTransport::default());
        core.begin_tick();
        assert!(core.transport_mut().drained_with.is_empty());
    }

    #[cfg(feature = "mount")]
    #[test]
    fn mounted_surface_round_trips_text_and_binary() {
        let guest = Guest::new().unwrap();
        let surface = SocketSurface::new(FixtureTransport::default());
        surface.mount(&guest).unwrap();
        guest
            .eval(
                "open",
                r#"globalThis.h = socket.open("ws://example.test/ws",
                     JSON.stringify({protocols: [], timeoutMs: 1000}));
                   globalThis.refused = socket.open("http://x/", "{}");
                   globalThis.why = socket.lastError();"#,
            )
            .unwrap();
        let (handle, refused, why): (i32, i32, String) = guest.with(|ctx| {
            let g = ctx.globals();
            (
                g.get("h").unwrap(),
                g.get("refused").unwrap(),
                g.get("why").unwrap(),
            )
        });
        assert_eq!((handle, refused), (1, -1));
        assert!(why.starts_with("invalid_request:"));
        surface.with_core(|core| {
            core.transport_mut().results.extend([
                SocketCompletion::Open {
                    handle,
                    protocol: String::new(),
                },
                SocketCompletion::Message {
                    handle,
                    payload: Payload::Binary(vec![7, 8]),
                },
            ])
        });
        surface.begin_tick();
        guest
            .eval(
                "pump",
                r#"const events = JSON.parse(socket.poll());
                   const m = events[1];
                   const out = new ArrayBuffer(m.bytes);
                   globalThis.copied = socket.take(m.m, out);
                   globalThis.first = new Uint8Array(out)[0];
                   globalThis.queued = socket.send(h, new Uint8Array([104, 105]).buffer, true);
                   globalThis.closed = socket.close(h, 1000, "done");"#,
            )
            .unwrap();
        let values: (i32, i32, f64, i32) = guest.with(|ctx| {
            let g = ctx.globals();
            (
                g.get("copied").unwrap(),
                g.get("first").unwrap(),
                g.get("queued").unwrap(),
                g.get("closed").unwrap(),
            )
        });
        assert_eq!(values, (2, 7, (2 + spec::MESSAGE_OVERHEAD_BYTES) as f64, 0));
        surface.with_core(|core| {
            assert_eq!(
                core.transport_mut().sent,
                vec![(handle, Payload::Text("hi".into()))]
            );
            assert_eq!(
                core.transport_mut().closed,
                vec![(handle, 1000, "done".into())]
            );
        });
    }
}
