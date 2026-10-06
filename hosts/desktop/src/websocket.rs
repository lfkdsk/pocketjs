//! net.socket transport: `tungstenite` (blocking, rustls for wss://) on one
//! I/O thread per connection behind the pocket-socket core.
//!
//! Each connection thread owns its socket. It connects (DNS, TCP, TLS and the
//! HTTP upgrade under one deadline), then loops: write queued commands, read
//! with a short timeout, report results through a shared channel. The thread
//! never touches QuickJS; results wait in the channel until
//! `SocketCore::begin_tick` drains a bounded number of them.
//!
//! Bounds held here:
//! - inbound: a thread reads the next message only while one more message of
//!   the largest size (plus SOCKET_MESSAGE_OVERHEAD_BYTES) still fits in
//!   `max_recv_queue_bytes` of undelivered charge, so the queue never exceeds
//!   the limit and TCP flow control throttles the peer;
//! - outbound: the core refuses sends beyond SOCKET_MAX_SEND_QUEUE_BYTES of
//!   charge and is credited through `take_sent` after messages reach the
//!   kernel;
//! - opening handshake: DNS and TCP connect go through `dial` under the same
//!   deadline as TLS and the upgrade; response bytes read before the upgrade
//!   completes are capped (`HANDSHAKE_BYTES`) and redirects are not followed.
//!
//! Cancellation: `close()` before `open`, or host exit, ends the attempt
//! within a few milliseconds in every phase. DNS and TCP connect poll the
//! abort; during TLS and the upgrade the transport shuts the TCP stream down,
//! which ends the blocked read or write. The only close event is
//! `close(1006, clean=false)`.
//!
//! Teardown: dropping the transport shuts down connections that are not open
//! yet at once, gives open ones `EXIT_GRACE` to send a 1001 close frame, then
//! shuts down every TCP stream still in use and joins every connection
//! thread; when `drop` returns, every connection's TCP stream is closed. DNS
//! lookups still inside the system resolver are abandoned (see `dial`).
use crate::dial::{Dial, DialError, Lookups, Resolve, system_resolve};
use pocket_socket::{Payload, Sent, SocketCompletion, SocketFailure, SocketOpen, SocketTransport};
use pocketjs_core::spec::socket as spec;
use std::{
    cell::Cell,
    collections::HashMap,
    io::{self, Read, Write},
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{Receiver, Sender, TryRecvError, channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tungstenite::{
    Message, WebSocket,
    client::IntoClientRequest,
    error::{CapacityError, Error as WsError, ProtocolError},
    protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    stream::MaybeTlsStream,
};

/// Read timeout of the I/O loop: the latency bound for picking up a send.
const POLL: Duration = Duration::from_millis(4);
/// Bytes accepted from the server before the upgrade completes (TLS
/// certificates included).
const HANDSHAKE_BYTES: usize = 64 * 1024;
/// Accounting charge per message on top of its payload.
const MESSAGE_OVERHEAD: usize = spec::MESSAGE_OVERHEAD_BYTES;
/// Time open connections get on host exit to send their 1001 close frame
/// before their TCP streams are shut down.
const EXIT_GRACE: Duration = Duration::from_millis(150);
/// DNS lookups still running after their connection gave up on them. Opens
/// beyond this are refused with `busy` until the lookups return.
const MAX_STRAY_LOOKUPS: usize = 8;
/// Time allowed for the peer to answer our close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// A blocked write longer than this fails the connection.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

enum Command {
    Send(Payload),
    Close(u16, String),
}

/// A clone of a connection's TCP stream, held so teardown can shut it down
/// while the connection thread is blocked on it. The thread empties the slot
/// before it exits so the clone does not keep the connection open.
type TcpSlot = Arc<Mutex<Option<TcpStream>>>;

/// Messages and payload bytes written to the kernel and not yet credited.
#[derive(Default)]
struct SentCounter {
    messages: AtomicUsize,
    bytes: AtomicUsize,
}

struct Connection {
    commands: Sender<Command>,
    sent: Arc<SentCounter>,
    undelivered: Arc<AtomicUsize>,
    tcp: TcpSlot,
    /// Set by the connection thread once the upgrade has completed.
    opened: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Connection {
    fn shutdown(&self) {
        if let Some(tcp) = self.tcp.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tcp.shutdown(std::net::Shutdown::Both);
        }
    }
}

pub struct WsTransport {
    tx: Sender<(i32, SocketCompletion)>,
    rx: Receiver<(i32, SocketCompletion)>,
    connections: HashMap<i32, Connection>,
    stop: Arc<AtomicBool>,
    lookups: Lookups,
    resolve: Resolve,
}

impl Default for WsTransport {
    fn default() -> Self {
        let (tx, rx) = channel();
        Self {
            tx,
            rx,
            connections: HashMap::new(),
            stop: Arc::new(AtomicBool::new(false)),
            lookups: Lookups::default(),
            resolve: system_resolve,
        }
    }
}

impl WsTransport {
    /// Received payload (plus per-message overhead) the I/O thread holds for
    /// a handle that the core has not drained yet.
    #[cfg(test)]
    pub fn undelivered(&self, handle: i32) -> usize {
        self.connections.get(&handle).map_or(0, |connection| {
            connection.undelivered.load(Ordering::Acquire)
        })
    }

    #[cfg(test)]
    pub fn with_resolver(resolve: Resolve) -> Self {
        let mut transport = Self::default();
        transport.resolve = resolve;
        transport
    }
}

impl SocketTransport for WsTransport {
    fn open(&mut self, request: SocketOpen) -> Result<(), SocketFailure> {
        let handle = request.handle;
        if self.lookups.reap() >= MAX_STRAY_LOOKUPS {
            return Err(SocketFailure::new(
                spec::ERROR_BUSY,
                "abandoned DNS lookups are still running",
            ));
        }
        let (commands, inbox) = channel();
        let sent = Arc::new(SentCounter::default());
        let undelivered = Arc::new(AtomicUsize::new(0));
        let tcp: TcpSlot = Arc::new(Mutex::new(None));
        let opened = Arc::new(AtomicBool::new(false));
        let io = Io {
            handle,
            events: self.tx.clone(),
            inbox,
            sent: sent.clone(),
            undelivered: undelivered.clone(),
            stop: self.stop.clone(),
            tcp: tcp.clone(),
            opened: opened.clone(),
            aborted: Cell::new(false),
            lookups: self.lookups.clone(),
            resolve: self.resolve,
            recv_limit: request.max_recv_queue_bytes,
            max_message: request.max_message_bytes,
        };
        let thread = thread::Builder::new()
            .name(format!("pocket-socket-{handle}"))
            .spawn(move || io.run(request))
            .map_err(|e| SocketFailure::new(spec::ERROR_OTHER, format!("thread spawn: {e}")))?;
        self.connections.insert(
            handle,
            Connection {
                commands,
                sent,
                undelivered,
                tcp,
                opened,
                thread: Some(thread),
            },
        );
        Ok(())
    }

    fn send(&mut self, handle: i32, payload: Payload) -> Result<(), SocketFailure> {
        let connection = self
            .connections
            .get(&handle)
            .ok_or_else(|| SocketFailure::new(spec::ERROR_CLOSED, "socket is closed"))?;
        connection
            .commands
            .send(Command::Send(payload))
            .map_err(|_| SocketFailure::new(spec::ERROR_CLOSED, "socket is closed"))
    }

    fn close(&mut self, handle: i32, code: u16, reason: String) {
        if let Some(connection) = self.connections.get(&handle) {
            let _ = connection.commands.send(Command::Close(code, reason));
            // Before open the thread may be blocked in TLS or the upgrade;
            // the queued close tells it why its stream failed.
            if !connection.opened.load(Ordering::SeqCst) {
                connection.shutdown();
            }
        }
    }

    fn take_sent(&mut self, handle: i32) -> Sent {
        self.connections
            .get(&handle)
            .map_or(Sent::default(), |connection| Sent {
                messages: connection.sent.messages.swap(0, Ordering::AcqRel),
                bytes: connection.sent.bytes.swap(0, Ordering::AcqRel),
            })
    }

    fn drain(&mut self, completions: &mut Vec<SocketCompletion>, max: usize) {
        for _ in 0..max {
            let (handle, completion) = match self.rx.try_recv() {
                Ok(item) => item,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            };
            if let SocketCompletion::Message { payload, .. } = &completion
                && let Some(connection) = self.connections.get(&handle)
            {
                connection
                    .undelivered
                    .fetch_sub(payload.len() + MESSAGE_OVERHEAD, Ordering::AcqRel);
            }
            if matches!(completion, SocketCompletion::Closed { .. })
                && let Some(mut connection) = self.connections.remove(&handle)
                && let Some(thread) = connection.thread.take()
            {
                let _ = thread.join(); // reported its terminal result; exits next
            }
            completions.push(completion);
        }
    }
}

impl Drop for WsTransport {
    /// Host exit: connections not open yet are shut down at once; open ones
    /// send a 1001 close frame within `EXIT_GRACE`; then every TCP stream
    /// still in use is shut down, which ends blocked reads and writes, and
    /// every connection thread is joined. Abandoned DNS lookups are not.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let connections: Vec<Connection> = self.connections.drain().map(|(_, c)| c).collect();
        for connection in &connections {
            if !connection.opened.load(Ordering::SeqCst) {
                connection.shutdown();
            }
        }
        let deadline = Instant::now() + EXIT_GRACE;
        while Instant::now() < deadline
            && connections
                .iter()
                .any(|c| c.thread.as_ref().is_some_and(|t| !t.is_finished()))
        {
            thread::sleep(Duration::from_millis(2));
        }
        for connection in &connections {
            connection.shutdown();
        }
        for mut connection in connections {
            if let Some(thread) = connection.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// TCP stream that refuses to read more than `budget` bytes while armed.
struct Capped {
    tcp: TcpStream,
    budget: Arc<AtomicUsize>,
}

impl Read for Capped {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let budget = self.budget.load(Ordering::Relaxed);
        if budget == 0 {
            return Err(io::Error::other(
                "opening handshake exceeded its byte limit",
            ));
        }
        let limit = buf.len().min(budget);
        let n = self.tcp.read(&mut buf[..limit])?;
        if budget != usize::MAX {
            self.budget.store(budget - n, Ordering::Relaxed);
        }
        Ok(n)
    }
}

impl Write for Capped {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tcp.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.tcp.flush()
    }
}

type Socket = WebSocket<MaybeTlsStream<Capped>>;

struct Io {
    handle: i32,
    events: Sender<(i32, SocketCompletion)>,
    inbox: Receiver<Command>,
    sent: Arc<SentCounter>,
    undelivered: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    tcp: TcpSlot,
    opened: Arc<AtomicBool>,
    /// Sticky: close() or host exit was seen while connecting.
    aborted: Cell<bool>,
    lookups: Lookups,
    resolve: Resolve,
    recv_limit: usize,
    max_message: usize,
}

enum Exit {
    /// Close handshake finished or the peer closed: code and reason.
    Clean(u16, String),
    /// Failure: portable error, then close code reported with clean=false.
    Failed(SocketFailure, u16),
    /// close() or host exit before open: only close(1006, clean=false).
    Aborted,
}

impl Io {
    fn emit(&self, completion: SocketCompletion) {
        let _ = self.events.send((self.handle, completion));
    }

    fn run(self, request: SocketOpen) {
        let exit = self.session(&request);
        // Release the teardown clone before reporting the terminal result, so
        // the stream is closed by the time the guest can see `close`.
        self.tcp.lock().unwrap_or_else(|e| e.into_inner()).take();
        self.report(exit);
    }

    fn session(&self, request: &SocketOpen) -> Exit {
        match self.connect(request) {
            Ok((socket, ctl, protocol)) => {
                self.emit(SocketCompletion::Open {
                    handle: self.handle,
                    protocol,
                });
                self.pump(socket, ctl)
            }
            Err(exit) => exit,
        }
    }

    fn report(&self, exit: Exit) {
        match exit {
            Exit::Clean(code, reason) => self.emit(SocketCompletion::Closed {
                handle: self.handle,
                code,
                reason,
                clean: true,
            }),
            Exit::Failed(failure, code) => {
                self.emit(SocketCompletion::Error {
                    handle: self.handle,
                    failure,
                });
                self.emit(SocketCompletion::Closed {
                    handle: self.handle,
                    code,
                    reason: String::new(),
                    clean: false,
                });
            }
            Exit::Aborted => self.emit(SocketCompletion::Closed {
                handle: self.handle,
                code: spec::CLOSE_ABNORMAL,
                reason: String::new(),
                clean: false,
            }),
        }
    }

    fn aborted(&self) -> bool {
        if self.aborted.get() || self.stop.load(Ordering::SeqCst) {
            self.aborted.set(true);
            return true;
        }
        // A close() issued while connecting abandons the attempt.
        loop {
            match self.inbox.try_recv() {
                Ok(Command::Close(..)) | Err(TryRecvError::Disconnected) => {
                    self.aborted.set(true);
                    return true;
                }
                Ok(Command::Send(_)) => {} // the core refuses sends before open
                Err(TryRecvError::Empty) => return false,
            }
        }
    }

    fn connect(&self, request: &SocketOpen) -> Result<(Socket, TcpStream, String), Exit> {
        let fail = |code: &str, message: String| {
            Exit::Failed(SocketFailure::new(code, message), spec::CLOSE_ABNORMAL)
        };
        let deadline = Instant::now() + Duration::from_millis(u64::from(request.timeout_ms));
        let remaining = || {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                Err(fail(
                    spec::ERROR_TIMEOUT,
                    "opening handshake timed out".into(),
                ))
            } else {
                Ok(left)
            }
        };
        let mut upgrade = request
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| fail(spec::ERROR_INVALID_REQUEST, e.to_string()))?;
        if !request.protocols.is_empty() {
            let value = request.protocols.join(", ");
            upgrade.headers_mut().insert(
                "sec-websocket-protocol",
                value
                    .parse()
                    .map_err(|_| fail(spec::ERROR_INVALID_REQUEST, "bad protocol".into()))?,
            );
        }
        let uri = upgrade.uri().clone();
        let secure = uri.scheme_str() == Some("wss");
        let host = uri
            .host()
            .ok_or_else(|| fail(spec::ERROR_INVALID_REQUEST, "url has no host".into()))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
        let dial = Dial {
            deadline,
            cancelled: &|| self.aborted(),
            resolve: self.resolve,
            lookups: &self.lookups,
        };
        let tcp = dial.connect(host, port).map_err(|error| match error {
            DialError::Cancelled => Exit::Aborted,
            DialError::Timeout(message) => fail(spec::ERROR_TIMEOUT, message),
            DialError::Dns(message) => fail(spec::ERROR_DNS, message),
            DialError::Connect(message) => fail(spec::ERROR_CONNECT, message),
            DialError::Other(message) => fail(spec::ERROR_OTHER, message),
        })?;
        let ctl = tcp
            .try_clone()
            .map_err(|e| fail(spec::ERROR_OTHER, e.to_string()))?;
        let teardown = tcp
            .try_clone()
            .map_err(|e| fail(spec::ERROR_OTHER, e.to_string()))?;
        // Publish the clone, then look at the exit flag: a teardown that
        // missed the clone has already set the flag.
        *self.tcp.lock().unwrap_or_else(|e| e.into_inner()) = Some(teardown);
        if self.aborted() {
            return Err(Exit::Aborted);
        }
        let _ = tcp.set_nodelay(true);
        let left = remaining()?;
        ctl.set_read_timeout(Some(left))
            .and_then(|_| ctl.set_write_timeout(Some(left)))
            .map_err(|e| fail(spec::ERROR_OTHER, e.to_string()))?;
        let budget = Arc::new(AtomicUsize::new(HANDSHAKE_BYTES));
        let stream = Capped {
            tcp,
            budget: budget.clone(),
        };
        let config = WebSocketConfig::default()
            .max_message_size(Some(request.max_message_bytes))
            .max_frame_size(Some(request.max_message_bytes));
        let (socket, response) =
            match tungstenite::client_tls_with_config(upgrade, stream, Some(config), None) {
                Ok(pair) => pair,
                // close() or host exit shut the stream down.
                Err(_) if self.aborted() => return Err(Exit::Aborted),
                Err(tungstenite::HandshakeError::Failure(error)) => {
                    return Err(map_handshake(error));
                }
                Err(tungstenite::HandshakeError::Interrupted(_)) => {
                    return Err(fail(
                        spec::ERROR_TIMEOUT,
                        "opening handshake timed out".into(),
                    ));
                }
            };
        budget.store(usize::MAX, Ordering::Relaxed);
        // From here close() leaves the stream to the closing handshake; a
        // close() that saw `opened` unset has already queued its command.
        self.opened.store(true, Ordering::SeqCst);
        if self.aborted() {
            let mut socket = socket;
            let _ = socket.close(None);
            let _ = socket.flush();
            return Err(Exit::Aborted);
        }
        let protocol = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !protocol.is_empty() && !request.protocols.contains(&protocol) {
            return Err(fail(
                spec::ERROR_HANDSHAKE,
                format!("server selected unoffered protocol {protocol:?}"),
            ));
        }
        ctl.set_read_timeout(Some(POLL))
            .and_then(|_| ctl.set_write_timeout(Some(WRITE_TIMEOUT)))
            .map_err(|e| fail(spec::ERROR_OTHER, e.to_string()))?;
        Ok((socket, ctl, protocol))
    }

    fn pump(&self, mut socket: Socket, ctl: TcpStream) -> Exit {
        // Some(deadline) once our close frame is queued.
        let mut closing: Option<Instant> = None;
        // Messages and bytes queued in tungstenite, not yet credited.
        let mut unflushed = 0usize;
        let mut unflushed_messages = 0usize;
        loop {
            if closing.is_none() && self.stop.load(Ordering::Acquire) {
                let _ = socket.close(Some(CloseFrame {
                    code: CloseCode::Away,
                    reason: "host exit".into(),
                }));
                closing = Some(Instant::now() + EXIT_GRACE);
            }
            // 1. Commands from the core: queue frames, then flush once.
            while closing.is_none() {
                match self.inbox.try_recv() {
                    Ok(Command::Send(payload)) => {
                        let len = payload.len();
                        let message = match payload {
                            Payload::Text(text) => Message::text(text),
                            Payload::Binary(bytes) => Message::binary(bytes),
                        };
                        if let Err(error) = socket.write(message)
                            && let Some(exit) = self.io_failure(error)
                        {
                            return exit;
                        }
                        unflushed += len;
                        unflushed_messages += 1;
                    }
                    Ok(Command::Close(code, reason)) => {
                        let _ = socket.close(Some(CloseFrame {
                            code: CloseCode::from(code),
                            reason: reason.into(),
                        }));
                        closing = Some(Instant::now() + CLOSE_GRACE);
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        let _ = socket.close(None);
                        closing = Some(Instant::now() + CLOSE_GRACE);
                    }
                }
            }
            match socket.flush() {
                Ok(()) => {
                    if unflushed_messages > 0 {
                        self.sent.bytes.fetch_add(unflushed, Ordering::AcqRel);
                        self.sent
                            .messages
                            .fetch_add(unflushed_messages, Ordering::AcqRel);
                        unflushed = 0;
                        unflushed_messages = 0;
                    }
                }
                Err(error) => {
                    if let Some(exit) = self.io_failure(error) {
                        return exit;
                    }
                }
            }
            if let Some(deadline) = closing
                && Instant::now() >= deadline
            {
                let _ = ctl.shutdown(std::net::Shutdown::Both);
                return Exit::Failed(
                    SocketFailure::new(spec::ERROR_TIMEOUT, "peer did not answer the close frame"),
                    spec::CLOSE_ABNORMAL,
                );
            }
            // 2. Inbound, only while a largest message still fits the
            // undelivered budget, so the charge never exceeds the limit.
            if self.undelivered.load(Ordering::Acquire) + self.max_message + MESSAGE_OVERHEAD
                > self.recv_limit
            {
                thread::sleep(POLL);
                continue;
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    self.deliver(Payload::Text(text.as_str().to_string()));
                }
                Ok(Message::Binary(bytes)) => self.deliver(Payload::Binary(bytes.to_vec())),
                Ok(Message::Close(frame)) => {
                    // tungstenite queues the echo; the next read or flush
                    // completes the handshake and ends in ConnectionClosed.
                    let (code, reason) = frame.map_or((1005, String::new()), |f| {
                        (u16::from(f.code), f.reason.as_str().to_string())
                    });
                    return self.finish(socket, code, reason);
                }
                Ok(_) => {} // ping/pong/raw frames: tungstenite answers pings
                Err(WsError::ConnectionClosed) => {
                    return Exit::Clean(spec::CLOSE_NORMAL, String::new());
                }
                Err(error) => {
                    if let Some(exit) = self.io_failure(error) {
                        return exit;
                    }
                }
            }
        }
    }

    /// The peer sent a close frame: flush our echo and wait briefly for the
    /// server to drop TCP, then report the peer's code.
    fn finish(&self, mut socket: Socket, code: u16, reason: String) -> Exit {
        let deadline = Instant::now() + CLOSE_GRACE;
        while Instant::now() < deadline {
            match socket.read() {
                Ok(_) => {}
                Err(WsError::Io(e)) if is_timeout(&e) => {}
                Err(_) => break,
            }
        }
        Exit::Clean(code, reason)
    }

    fn deliver(&self, payload: Payload) {
        self.undelivered
            .fetch_add(payload.len() + MESSAGE_OVERHEAD, Ordering::AcqRel);
        self.emit(SocketCompletion::Message {
            handle: self.handle,
            payload,
        });
    }

    /// None for a retryable timeout, otherwise the terminal exit.
    fn io_failure(&self, error: WsError) -> Option<Exit> {
        let (code, message, close) = match error {
            WsError::Io(e) if is_timeout(&e) => return None,
            WsError::ConnectionClosed | WsError::AlreadyClosed => {
                return Some(Exit::Clean(spec::CLOSE_NORMAL, String::new()));
            }
            WsError::Capacity(CapacityError::MessageTooLong { size, max_size }) => (
                spec::ERROR_MESSAGE_TOO_LARGE,
                format!("message of {size} bytes exceeds {max_size}"),
                spec::CLOSE_MESSAGE_TOO_BIG,
            ),
            WsError::Capacity(e) => (
                spec::ERROR_PROTOCOL,
                e.to_string(),
                spec::CLOSE_PROTOCOL_ERROR,
            ),
            WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => (
                spec::ERROR_CONNECT,
                "connection reset without a closing handshake".into(),
                spec::CLOSE_ABNORMAL,
            ),
            WsError::Protocol(e) => (
                spec::ERROR_PROTOCOL,
                e.to_string(),
                spec::CLOSE_PROTOCOL_ERROR,
            ),
            WsError::Utf8(e) => (
                spec::ERROR_PROTOCOL,
                e.to_string(),
                spec::CLOSE_INVALID_PAYLOAD,
            ),
            WsError::Io(e) => (spec::ERROR_CONNECT, e.to_string(), spec::CLOSE_ABNORMAL),
            other => (spec::ERROR_OTHER, other.to_string(), spec::CLOSE_ABNORMAL),
        };
        Some(Exit::Failed(SocketFailure::new(code, message), close))
    }
}

fn is_timeout(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
    )
}

fn map_handshake(error: WsError) -> Exit {
    let (code, message) = match error {
        WsError::Io(e) if is_timeout(&e) => (spec::ERROR_TIMEOUT, e.to_string()),
        WsError::Io(e) => (spec::ERROR_CONNECT, e.to_string()),
        WsError::Tls(e) => (spec::ERROR_TLS, e.to_string()),
        WsError::Http(response) => (
            spec::ERROR_HANDSHAKE,
            format!(
                "server answered the upgrade with HTTP {}",
                response.status()
            ),
        ),
        WsError::Url(e) => (spec::ERROR_INVALID_REQUEST, e.to_string()),
        WsError::Capacity(e) => (spec::ERROR_HANDSHAKE, e.to_string()),
        WsError::Protocol(e) => (spec::ERROR_HANDSHAKE, e.to_string()),
        other => (spec::ERROR_OTHER, other.to_string()),
    };
    // rustls reports certificate failures as I/O errors carrying the TLS
    // alert text.
    let code = if code == spec::ERROR_CONNECT
        && (message.contains("certificate") || message.contains("TLS"))
    {
        spec::ERROR_TLS
    } else {
        code
    };
    Exit::Failed(SocketFailure::new(code, message), spec::CLOSE_ABNORMAL)
}
