//! net.http transport: a blocking HTTP/1.1 client (rustls for https://) on
//! one worker thread per request behind the pocket-net core. Workers never
//! touch QuickJS; their completions wait in a channel until
//! `NetCore::begin_tick` drains them at the tick boundary.
//!
//! Each hop is one `connection: close` exchange; the body is framed by
//! `content-length`, `chunked` or the end of the stream. Redirects are
//! followed here, so every hop is checked: at most `max_redirects`, the same
//! scheme as the original URL (no https -> http or http -> https hop), and
//! credentials dropped when the origin changes. One deadline covers DNS,
//! every hop and the body read.
//!
//! Cancellation: `cancel()` and dropping the transport set the request's
//! flag, which DNS and TCP connect poll (see `dial`), and shut its TCP stream
//! down, which ends a blocked TLS handshake, write or read at once. Dropping
//! the transport joins every worker, so every request's TCP stream is closed
//! when `drop` returns; DNS lookups still inside the system resolver are
//! abandoned.
use crate::dial::{Dial, DialError, Lookups, Resolve, system_resolve};
use pocket_net::{HttpRequest, HttpTransport, NetFailure, TransportCompletion};
use pocketjs_core::spec::net as spec;
use std::{
    collections::{BTreeMap, HashMap},
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpStream},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, Sender, channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Worker threads alive at once, including cancelled requests whose thread
/// has not ended yet and DNS lookups their request stopped waiting for. The
/// core admits NET_MAX_INFLIGHT requests; the slack lets a guest cancel and
/// retry without growing threads unboundedly.
const MAX_WORKERS: usize = 8;
/// Bytes accepted for one response status line and its headers.
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// Header slots handed to the parser; more is a protocol error.
const MAX_PARSED_HEADERS: usize = 128;
/// Request headers this client writes itself; guest values are ignored.
const OWNED_HEADERS: [&str; 4] = ["connection", "content-length", "host", "transfer-encoding"];
/// Sent unless the guest sets them.
const DEFAULT_HEADERS: [(&str, &str); 2] = [("accept", "*/*"), ("user-agent", "PocketJS")];

/// A clone of a request's TCP stream, held so cancellation can shut it down
/// while the worker is blocked on it.
type TcpSlot = Arc<Mutex<Option<TcpStream>>>;

struct Worker {
    cancelled: Arc<AtomicBool>,
    tcp: TcpSlot,
    thread: JoinHandle<()>,
}

impl Worker {
    /// Set the flag, then shut down the published stream: a worker that
    /// publishes a stream afterwards sees the flag.
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(tcp) = self.tcp.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tcp.shutdown(Shutdown::Both);
        }
    }
}

pub struct FetchTransport {
    tx: Sender<TransportCompletion>,
    rx: Receiver<TransportCompletion>,
    workers: HashMap<i32, Worker>,
    /// Cancelled workers that have not ended yet; joined once they finish.
    orphans: Vec<JoinHandle<()>>,
    lookups: Lookups,
    resolve: Resolve,
}

impl Default for FetchTransport {
    fn default() -> Self {
        let (tx, rx) = channel();
        Self {
            tx,
            rx,
            workers: HashMap::new(),
            orphans: Vec::new(),
            lookups: Lookups::default(),
            resolve: system_resolve,
        }
    }
}

impl FetchTransport {
    #[cfg(test)]
    pub fn with_resolver(resolve: Resolve) -> Self {
        let mut transport = Self::default();
        transport.resolve = resolve;
        transport
    }

    /// Join finished orphans and lookups; returns how many are still running.
    fn reap(&mut self) -> usize {
        let mut i = 0;
        while i < self.orphans.len() {
            if self.orphans[i].is_finished() {
                let _ = self.orphans.swap_remove(i).join();
            } else {
                i += 1;
            }
        }
        self.orphans.len() + self.lookups.reap()
    }
}

impl HttpTransport for FetchTransport {
    fn start(&mut self, request: HttpRequest) -> Result<(), NetFailure> {
        if self.workers.len() + self.reap() >= MAX_WORKERS {
            return Err(NetFailure::new(
                spec::ERROR_BUSY,
                "cancelled requests are still draining",
            ));
        }
        let handle = request.handle;
        let cancelled = Arc::new(AtomicBool::new(false));
        let tcp: TcpSlot = Arc::new(Mutex::new(None));
        let exchange = Exchange {
            deadline: Instant::now() + Duration::from_millis(u64::from(request.timeout_ms)),
            cancelled: cancelled.clone(),
            tcp: tcp.clone(),
            lookups: self.lookups.clone(),
            resolve: self.resolve,
        };
        let tx = self.tx.clone();
        let thread = thread::Builder::new()
            .name(format!("pocket-net-{handle}"))
            .spawn(move || {
                let completion = match perform(&request, &exchange) {
                    Ok((status, url, headers, body)) => TransportCompletion::Done {
                        handle,
                        status,
                        url,
                        headers,
                        body,
                    },
                    Err(failure) => TransportCompletion::Error { handle, failure },
                };
                exchange
                    .tcp
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if !exchange.cancelled.load(Ordering::SeqCst) {
                    let _ = tx.send(completion);
                }
            })
            .map_err(|e| NetFailure::new(spec::ERROR_OTHER, format!("worker spawn: {e}")))?;
        self.workers.insert(
            handle,
            Worker {
                cancelled,
                tcp,
                thread,
            },
        );
        Ok(())
    }

    fn cancel(&mut self, handle: i32) {
        if let Some(worker) = self.workers.remove(&handle) {
            worker.cancel();
            self.orphans.push(worker.thread);
        }
    }

    fn drain(&mut self, completions: &mut Vec<TransportCompletion>) {
        for completion in self.rx.try_iter() {
            let handle = match &completion {
                TransportCompletion::Done { handle, .. }
                | TransportCompletion::Error { handle, .. } => *handle,
            };
            if let Some(worker) = self.workers.remove(&handle) {
                let _ = worker.thread.join(); // sent its result; exits next
                completions.push(completion);
            }
        }
        self.reap();
    }
}

impl Drop for FetchTransport {
    /// Cancels every request (shutting its TCP stream down) and joins every
    /// worker. Abandoned DNS lookups are not joined.
    fn drop(&mut self) {
        let mut threads: Vec<JoinHandle<()>> = std::mem::take(&mut self.orphans);
        for (_, worker) in self.workers.drain() {
            worker.cancel();
            threads.push(worker.thread);
        }
        for thread in threads {
            let _ = thread.join();
        }
    }
}

type Response = (u16, String, BTreeMap<String, String>, Vec<u8>);

fn perform(request: &HttpRequest, exchange: &Exchange) -> Result<Response, NetFailure> {
    let original = url::Url::parse(&request.url)
        .map_err(|e| NetFailure::new(spec::ERROR_INVALID_REQUEST, format!("url: {e}")))?;
    let mut url = original.clone();
    let mut method = request.method.clone();
    let mut body: Option<&[u8]> = Some(&request.body);
    let mut headers = request.headers.clone();
    let mut hops = 0;
    loop {
        let hop = exchange.run(&method, &url, &headers, body, request.max_bytes)?;
        if let Some(location) = hop.location {
            hops += 1;
            if hops > request.max_redirects {
                return Err(NetFailure::new(
                    spec::ERROR_REDIRECT,
                    format!("more than {} redirects", request.max_redirects),
                ));
            }
            let next = url.join(&location).map_err(|e| {
                NetFailure::new(spec::ERROR_REDIRECT, format!("bad redirect location: {e}"))
            })?;
            if next.scheme() != original.scheme() {
                return Err(NetFailure::new(
                    spec::ERROR_REDIRECT,
                    format!("redirect changes scheme to {}", next.scheme()),
                ));
            }
            if next.as_str().len() > spec::MAX_URL_BYTES {
                return Err(NetFailure::new(
                    spec::ERROR_REDIRECT,
                    "redirect URL too long",
                ));
            }
            if next.origin() != url.origin() {
                headers.remove("authorization");
                headers.remove("cookie");
                headers.remove("proxy-authorization");
            }
            // 303 always, and 301/302 after POST, continue as a bodiless GET
            // (the WHATWG fetch rule); 307/308 replay method and body.
            if hop.status == 303 && method != "HEAD"
                || matches!(hop.status, 301 | 302) && method == "POST"
            {
                method = "GET".into();
                body = None;
                headers.remove("content-type");
                headers.remove("content-length");
            }
            url = next;
            continue;
        }
        if hop.headers.len() > spec::MAX_HEADERS || hop.header_bytes > spec::MAX_HEADER_BYTES {
            return Err(NetFailure::new(
                spec::ERROR_PROTOCOL,
                "response headers exceed the portable contract",
            ));
        }
        return Ok((hop.status, url.to_string(), hop.headers, hop.body));
    }
}

/// One request's connection state, shared by all of its hops.
struct Exchange {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    tcp: TcpSlot,
    lookups: Lookups,
    resolve: Resolve,
}

/// One hop's response: `location` is set for a redirect, whose body is not
/// read.
struct Hop {
    status: u16,
    headers: BTreeMap<String, String>,
    header_bytes: usize,
    location: Option<String>,
    body: Vec<u8>,
}

impl Exchange {
    fn run(
        &self,
        method: &str,
        url: &url::Url,
        headers: &BTreeMap<String, String>,
        body: Option<&[u8]>,
        max_bytes: usize,
    ) -> Result<Hop, NetFailure> {
        let secure = match url.scheme() {
            "https" => true,
            "http" => false,
            other => {
                return Err(NetFailure::new(
                    spec::ERROR_INVALID_REQUEST,
                    format!("unsupported scheme {other}"),
                ));
            }
        };
        let host = url
            .host_str()
            .ok_or_else(|| NetFailure::new(spec::ERROR_INVALID_REQUEST, "url has no host"))?;
        let name = host.trim_start_matches('[').trim_end_matches(']');
        let port = url.port_or_known_default().unwrap_or(80);
        let dial = Dial {
            deadline: self.deadline,
            cancelled: &|| self.cancelled.load(Ordering::SeqCst),
            resolve: self.resolve,
            lookups: &self.lookups,
        };
        let tcp = dial.connect(name, port).map_err(|error| match error {
            DialError::Cancelled => NetFailure::new(spec::ERROR_OTHER, "request cancelled"),
            DialError::Timeout(message) => NetFailure::new(spec::ERROR_TIMEOUT, message),
            DialError::Dns(message) => NetFailure::new(spec::ERROR_DNS, message),
            DialError::Connect(message) => NetFailure::new(spec::ERROR_CONNECT, message),
            DialError::Other(message) => NetFailure::new(spec::ERROR_OTHER, message),
        })?;
        // Publish the clone, then look at the flag: a cancel that missed the
        // clone has already set it.
        let teardown = tcp.try_clone().map_err(|e| map_io(&e))?;
        *self.tcp.lock().unwrap_or_else(|e| e.into_inner()) = Some(teardown);
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(NetFailure::new(spec::ERROR_OTHER, "request cancelled"));
        }
        let _ = tcp.set_nodelay(true);
        let timed = Timed {
            tcp,
            deadline: self.deadline,
        };
        let mut conn = if secure {
            let server = rustls::pki_types::ServerName::try_from(name.to_string())
                .map_err(|e| NetFailure::new(spec::ERROR_INVALID_REQUEST, e.to_string()))?;
            let client = rustls::ClientConnection::new(tls_config(), server)
                .map_err(|e| NetFailure::new(spec::ERROR_TLS, e.to_string()))?;
            Conn::Tls(Box::new(rustls::StreamOwned::new(client, timed)))
        } else {
            Conn::Plain(timed)
        };

        let target = &url[url::Position::BeforePath..url::Position::AfterQuery];
        let mut head = format!("{method} {target} HTTP/1.1\r\nhost: {host}");
        if let Some(port) = url.port() {
            head.push_str(&format!(":{port}"));
        }
        head.push_str("\r\nconnection: close\r\n");
        for (name, value) in headers {
            if !OWNED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        for (name, value) in DEFAULT_HEADERS {
            if !headers.keys().any(|key| key.eq_ignore_ascii_case(name)) {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        let body = body.unwrap_or_default();
        if !body.is_empty() || matches!(method, "POST" | "PUT" | "PATCH") {
            head.push_str(&format!("content-length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        conn.write_all(head.as_bytes())
            .and_then(|_| conn.write_all(body))
            .and_then(|_| conn.flush())
            .map_err(|e| map_io(&e))?;

        let mut reader = BufReader::new(conn);
        let (status, fields) = loop {
            let (status, fields) = read_head(&mut reader)?;
            match status {
                101 => {
                    return Err(NetFailure::new(
                        spec::ERROR_PROTOCOL,
                        "unexpected protocol switch",
                    ));
                }
                100..=199 => {} // interim response
                _ => break (status, fields),
            }
        };
        let mut headers = BTreeMap::new();
        let mut header_bytes = 0;
        for (name, _) in &fields {
            if headers.contains_key(name) {
                continue;
            }
            let value = fields
                .iter()
                .filter(|(other, _)| other == name)
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            header_bytes += name.len() + value.len() + 4;
            headers.insert(name.clone(), value);
        }
        if matches!(status, 301 | 302 | 303 | 307 | 308)
            && let Some(location) = headers.get("location")
        {
            return Ok(Hop {
                status,
                location: Some(location.clone()),
                headers,
                header_bytes,
                body: Vec::new(),
            });
        }
        let body = if method == "HEAD" || matches!(status, 204 | 304) {
            Vec::new()
        } else if headers
            .get("transfer-encoding")
            .and_then(|codings| codings.rsplit(',').next())
            .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked"))
        {
            read_chunked(&mut reader, max_bytes)?
        } else if let Some(length) = headers.get("content-length") {
            let length: usize = length
                .trim()
                .parse()
                .map_err(|_| NetFailure::new(spec::ERROR_PROTOCOL, "invalid content-length"))?;
            if length > max_bytes {
                return Err(too_large(max_bytes));
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).map_err(|e| map_body_io(&e))?;
            body
        } else {
            // Read one byte past the limit so an oversized body is detected
            // without reading (or buffering) the rest of it.
            let mut body = Vec::new();
            reader
                .take(max_bytes as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|e| map_io(&e))?;
            if body.len() > max_bytes {
                return Err(too_large(max_bytes));
            }
            body
        };
        Ok(Hop {
            status,
            headers,
            header_bytes,
            location: None,
            body,
        })
    }
}

/// Process-wide client configuration: the ring provider and the bundled
/// webpki roots.
fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

/// TCP stream whose every read and write is bounded by the request deadline.
struct Timed {
    tcp: TcpStream,
    deadline: Instant,
}

impl Timed {
    fn left(&self) -> io::Result<Duration> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "request deadline elapsed",
            ))
        } else {
            Ok(left)
        }
    }
}

impl Read for Timed {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.tcp.set_read_timeout(Some(self.left()?))?;
        self.tcp.read(buf)
    }
}

impl Write for Timed {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.tcp.set_write_timeout(Some(self.left()?))?;
        self.tcp.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.tcp.flush()
    }
}

enum Conn {
    Plain(Timed),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, Timed>>),
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(stream) => stream.read(buf),
            Conn::Tls(stream) => stream.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Conn::Plain(stream) => stream.write(buf),
            Conn::Tls(stream) => stream.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Conn::Plain(stream) => stream.flush(),
            Conn::Tls(stream) => stream.flush(),
        }
    }
}

/// One line without its CRLF, at most `cap` bytes.
fn read_line(reader: &mut BufReader<Conn>, cap: usize) -> Result<Vec<u8>, NetFailure> {
    let mut line = Vec::new();
    reader
        .by_ref()
        .take(cap as u64)
        .read_until(b'\n', &mut line)
        .map_err(|e| map_io(&e))?;
    if line.last() != Some(&b'\n') {
        return Err(NetFailure::new(
            spec::ERROR_PROTOCOL,
            if line.len() >= cap {
                "response line too long"
            } else {
                "connection closed mid-response"
            },
        ));
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(line)
}

/// Status and lowercase header fields of one response head.
fn read_head(reader: &mut BufReader<Conn>) -> Result<(u16, Vec<(String, String)>), NetFailure> {
    let protocol = |message: &str| NetFailure::new(spec::ERROR_PROTOCOL, message);
    let mut head = Vec::new();
    loop {
        let line = read_line(reader, MAX_HEAD_BYTES.saturating_sub(head.len()).max(1))?;
        if line.is_empty() && !head.is_empty() {
            break;
        }
        head.extend_from_slice(&line);
        head.extend_from_slice(b"\r\n");
        if head.len() >= MAX_HEAD_BYTES {
            return Err(protocol("response head too large"));
        }
    }
    head.extend_from_slice(b"\r\n");
    let mut slots = [httparse::EMPTY_HEADER; MAX_PARSED_HEADERS];
    let mut response = httparse::Response::new(&mut slots);
    match response.parse(&head) {
        Ok(httparse::Status::Complete(_)) => {}
        Ok(httparse::Status::Partial) => return Err(protocol("incomplete response head")),
        Err(e) => return Err(protocol(&format!("malformed response head: {e}"))),
    }
    let status = response.code.ok_or_else(|| protocol("missing status"))?;
    let mut fields = Vec::with_capacity(response.headers.len());
    for header in response.headers.iter() {
        let value =
            std::str::from_utf8(header.value).map_err(|_| protocol("non-UTF-8 header value"))?;
        fields.push((header.name.to_ascii_lowercase(), value.trim().to_string()));
    }
    Ok((status, fields))
}

fn read_chunked(reader: &mut BufReader<Conn>, max_bytes: usize) -> Result<Vec<u8>, NetFailure> {
    let protocol = |message: &str| NetFailure::new(spec::ERROR_PROTOCOL, message);
    let mut body = Vec::new();
    loop {
        let line = read_line(reader, 1024)?;
        let size = std::str::from_utf8(&line)
            .ok()
            .and_then(|line| line.split(';').next())
            .and_then(|size| usize::from_str_radix(size.trim(), 16).ok())
            .ok_or_else(|| protocol("malformed chunk size"))?;
        if size == 0 {
            // Trailer fields are read and discarded.
            let mut trailers = 0;
            loop {
                let line = read_line(reader, MAX_HEAD_BYTES)?;
                trailers += line.len();
                if line.is_empty() {
                    return Ok(body);
                }
                if trailers > MAX_HEAD_BYTES {
                    return Err(protocol("chunked trailers too large"));
                }
            }
        }
        let start = body.len();
        if size > max_bytes - start {
            return Err(too_large(max_bytes));
        }
        body.resize(start + size, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|e| map_body_io(&e))?;
        if !read_line(reader, 2)?.is_empty() {
            return Err(protocol("malformed chunk end"));
        }
    }
}

fn too_large(max_bytes: usize) -> NetFailure {
    NetFailure::new(
        spec::ERROR_RESPONSE_TOO_LARGE,
        format!("response exceeded {max_bytes} bytes"),
    )
}

fn map_body_io(error: &io::Error) -> NetFailure {
    if error.kind() == io::ErrorKind::UnexpectedEof {
        NetFailure::new(spec::ERROR_PROTOCOL, "connection closed mid-body")
    } else {
        map_io(error)
    }
}

fn map_io(error: &io::Error) -> NetFailure {
    use io::ErrorKind::*;
    let tls = error
        .get_ref()
        .is_some_and(|inner| inner.is::<rustls::Error>());
    let code = match error.kind() {
        _ if tls => spec::ERROR_TLS,
        TimedOut | WouldBlock => spec::ERROR_TIMEOUT,
        ConnectionRefused | ConnectionReset | ConnectionAborted | NotConnected | BrokenPipe => {
            spec::ERROR_CONNECT
        }
        _ if is_tls_message(&error.to_string()) => spec::ERROR_TLS,
        _ => spec::ERROR_PROTOCOL,
    };
    NetFailure::new(code, error.to_string())
}

fn is_tls_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("certificate") || lower.contains("tls") || lower.contains("handshake")
}
