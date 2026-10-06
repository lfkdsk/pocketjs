//! Transport conformance against in-process loopback servers: a minimal
//! HTTP/1.1 responder and a tungstenite WebSocket server on std threads.
use super::*;
use pocket_net::NetCore;
use pocket_socket::SocketCore;
use pocketjs_core::spec::{net as net_spec, socket as socket_spec};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Message,
    handshake::server::{Request, Response},
    protocol::{CloseFrame, frame::coding::CloseCode},
};

// ---------------------------------------------------------------------------
// HTTP fixture
// ---------------------------------------------------------------------------

struct HttpRequestSeen {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// Serves each connection on its own thread with `respond(request)`, which
/// returns the raw response bytes (None = hold the connection open).
fn http_server(
    respond: impl Fn(&HttpRequestSeen) -> Option<Vec<u8>> + Send + Sync + 'static,
) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let respond = Arc::new(respond);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let respond = respond.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() {
                    return;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut headers = Vec::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    let (name, value) = header.split_once(':').unwrap();
                    let (name, value) = (name.to_ascii_lowercase(), value.trim().to_string());
                    if name == "content-length" {
                        length = value.parse().unwrap();
                    }
                    headers.push((name, value));
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let seen = HttpRequestSeen {
                    method,
                    path,
                    headers,
                    body,
                };
                let mut stream = stream;
                match respond(&seen) {
                    Some(bytes) => {
                        let _ = stream.write_all(&bytes);
                    }
                    None => thread::sleep(Duration::from_secs(5)),
                }
            });
        }
    });
    port
}

fn http_response(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\n", body.len());
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("connection: close\r\n\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn fetch_meta(url: &str, method: &str, timeout_ms: u32, max_bytes: usize) -> String {
    serde_json::json!({
        "url": url,
        "method": method,
        "headers": {"x-pocket": "1"},
        "timeoutMs": timeout_ms,
        "maxBytes": max_bytes,
    })
    .to_string()
}

/// Tick the core at ~1 ms until a batch arrives.
fn net_events(core: &mut NetCore<FetchTransport>, within: Duration) -> Vec<Value> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        core.begin_tick();
        if let Some(batch) = core.poll() {
            return serde_json::from_str(&batch).unwrap();
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("no net event within {within:?}");
}

#[test]
fn fetch_completes_only_at_a_tick_boundary_with_lowercase_headers() {
    let port = http_server(|request| {
        assert_eq!(request.method, "POST");
        assert!(request.headers.contains(&("x-pocket".into(), "1".into())));
        assert!(
            request
                .headers
                .contains(&("user-agent".into(), "PocketJS".into()))
        );
        assert!(
            request
                .headers
                .contains(&("connection".into(), "close".into()))
        );
        let host = request.headers.iter().find(|(name, _)| name == "host");
        assert!(host.is_some_and(|(_, value)| value.starts_with("127.0.0.1:")));
        let mut body = b"echo:".to_vec();
        body.extend_from_slice(&request.body);
        Some(http_response("201 Created", &[("X-Reply", "yes")], &body))
    });
    let mut core = NetCore::new(FetchTransport::default());
    let url = format!("http://127.0.0.1:{port}/items");
    let handle = core.start(&fetch_meta(&url, "POST", 5_000, 1024), b"hello");
    assert!(handle > 0, "{}", core.last_error());
    thread::sleep(Duration::from_millis(200));
    assert!(core.poll().is_none(), "completion must wait for begin_tick");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["t"], "done");
    assert_eq!(events[0]["status"], 201);
    assert_eq!(events[0]["url"], url);
    assert_eq!(events[0]["headers"]["x-reply"], "yes");
    assert_eq!(core.take(handle).unwrap(), b"echo:hello");
}

#[test]
fn fetch_follows_same_scheme_redirects_and_refuses_scheme_changes() {
    let port = http_server(|request| {
        Some(match request.path.as_str() {
            "/a" => http_response("302 Found", &[("location", "/b")], b""),
            "/b" => {
                // 303 turns POST into a bodiless GET.
                http_response("303 See Other", &[("location", "/final")], b"")
            }
            "/final" => {
                let seen = format!("{} {}", request.method, request.body.len());
                http_response("200 OK", &[], seen.as_bytes())
            }
            "/secure" => http_response("301 Moved", &[("location", "https://127.0.0.1:1/")], b""),
            "/loop" => http_response("307 Again", &[("location", "/loop")], b""),
            _ => http_response("404 Not Found", &[], b""),
        })
    });
    let base = format!("http://127.0.0.1:{port}");
    let mut core = NetCore::new(FetchTransport::default());

    let h = core.start(&fetch_meta(&format!("{base}/a"), "POST", 5_000, 64), b"x");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["url"], format!("{base}/final"));
    assert_eq!(core.take(h).unwrap(), b"GET 0");

    core.start(
        &fetch_meta(&format!("{base}/secure"), "GET", 5_000, 64),
        b"",
    );
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_REDIRECT, "{events:?}");

    core.start(&fetch_meta(&format!("{base}/loop"), "GET", 5_000, 64), b"");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_REDIRECT, "{events:?}");
}

#[test]
fn fetch_bounds_body_size_and_time_and_maps_connect_failures() {
    let port = http_server(|request| match request.path.as_str() {
        "/big" => Some(http_response("200 OK", &[], &[b'x'; 2048])),
        _ => None, // hang
    });
    let mut core = NetCore::new(FetchTransport::default());
    let base = format!("http://127.0.0.1:{port}");

    core.start(&fetch_meta(&format!("{base}/big"), "GET", 5_000, 1024), b"");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_RESPONSE_TOO_LARGE);

    let started = Instant::now();
    core.start(&fetch_meta(&format!("{base}/hang"), "GET", 300, 1024), b"");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_TIMEOUT, "{events:?}");
    assert!(started.elapsed() < Duration::from_secs(2));

    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = closed.local_addr().unwrap().port();
    drop(closed);
    core.start(
        &fetch_meta(&format!("http://127.0.0.1:{dead}/"), "GET", 5_000, 64),
        b"",
    );
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_CONNECT, "{events:?}");
}

#[test]
fn fetch_cancel_drops_the_late_result_and_drop_does_not_hang() {
    let port = http_server(|_| None);
    let mut core = NetCore::new(FetchTransport::default());
    let url = format!("http://127.0.0.1:{port}/hang");
    let handle = core.start(&fetch_meta(&url, "GET", 400, 64), b"");
    core.cancel(handle);
    thread::sleep(Duration::from_millis(600));
    core.begin_tick();
    assert!(core.poll().is_none());
    core.start(&fetch_meta(&url, "GET", 60_000, 64), b"");
    let started = Instant::now();
    drop(core);
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// Accepts one connection, never answers, and records when the client side
/// of that TCP stream closes (read returns EOF or a reset).
fn silent_tcp_server() -> (u16, Arc<AtomicBool>, Arc<std::sync::Mutex<Option<Instant>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicBool::new(false));
    let closed_at = Arc::new(std::sync::Mutex::new(None));
    let (seen, closed) = (accepted.clone(), closed_at.clone());
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        seen.store(true, Ordering::Release);
        stream
            .set_read_timeout(Some(Duration::from_millis(5)))
            .unwrap();
        let give_up = Instant::now() + Duration::from_secs(20);
        let mut buf = [0u8; 4096];
        while Instant::now() < give_up {
            match stream.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => break,
            }
        }
        *closed.lock().unwrap() = Some(Instant::now());
    });
    (port, accepted, closed_at)
}

fn wait_for(flag: &AtomicBool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !flag.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline, "server never accepted");
        thread::sleep(Duration::from_millis(2));
    }
}

/// The TCP stream must already be closed when `drop` returns: the server
/// sees EOF within a few read polls of that instant.
fn assert_closed_by(closed_at: &std::sync::Mutex<Option<Instant>>, dropped: Instant) {
    thread::sleep(Duration::from_millis(100));
    let closed = closed_at
        .lock()
        .unwrap()
        .expect("TCP still open after drop returned");
    assert!(
        closed <= dropped + Duration::from_millis(50),
        "TCP closed {:?} after drop returned",
        closed - dropped
    );
}

static NET_LOOKUPS_DONE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn slow_net_resolve(host: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
    thread::sleep(Duration::from_millis(1500));
    NET_LOOKUPS_DONE.fetch_add(1, Ordering::AcqRel);
    std::net::ToSocketAddrs::to_socket_addrs(&(host, port)).map(Iterator::collect)
}

/// Upper bound from close(), cancel() or host exit to the worker's end.
const INTERRUPT: Duration = Duration::from_millis(200);

/// A lookup the transport gave up on is abandoned: drop returns at once and
/// the helper thread finishes on its own when the resolver returns.
fn assert_lookup_abandoned(
    done: &std::sync::atomic::AtomicUsize,
    before: usize,
    drop_took: Duration,
) {
    assert!(drop_took < INTERRUPT, "drop waited {drop_took:?} for DNS");
    assert_eq!(
        done.load(Ordering::Acquire),
        before,
        "drop joined the lookup"
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while done.load(Ordering::Acquire) == before {
        assert!(Instant::now() < deadline, "abandoned lookup never finished");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn fetch_drop_joins_a_blocked_worker_and_closes_its_tcp() {
    let (port, accepted, closed_at) = silent_tcp_server();
    let mut core = NetCore::new(FetchTransport::default());
    core.start(
        &fetch_meta(&format!("http://127.0.0.1:{port}/hang"), "GET", 1_500, 64),
        b"",
    );
    wait_for(&accepted);
    let started = Instant::now();
    drop(core);
    let dropped = Instant::now();
    assert!(dropped - started < Duration::from_secs(3));
    assert_closed_by(&closed_at, dropped);
}

#[test]
fn fetch_dns_is_bounded_by_the_request_deadline_and_abandoned_on_drop() {
    let before = NET_LOOKUPS_DONE.load(Ordering::Acquire);
    let mut core = NetCore::new(FetchTransport::with_resolver(slow_net_resolve));
    let started = Instant::now();
    core.start(&fetch_meta("http://localhost:9/", "GET", 200, 64), b"");
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["code"], net_spec::ERROR_TIMEOUT, "{events:?}");
    assert!(
        started.elapsed() < Duration::from_millis(1000),
        "{:?}",
        started.elapsed()
    );
    let dropping = Instant::now();
    drop(core);
    assert_lookup_abandoned(&NET_LOOKUPS_DONE, before, dropping.elapsed());
}

/// Accepts every connection, answers each request with a response head and
/// the first bytes of a longer body, then holds the stream open. Records
/// when the client closes.
fn stalled_body_server() -> (u16, Arc<AtomicBool>, Arc<std::sync::Mutex<Option<Instant>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let sent = Arc::new(AtomicBool::new(false));
    let closed_at = Arc::new(std::sync::Mutex::new(None));
    let (seen, closed) = (sent.clone(), closed_at.clone());
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
            line.clear();
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\npartial")
            .unwrap();
        seen.store(true, Ordering::Release);
        let mut buf = [0u8; 64];
        let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
        let _ = stream.read(&mut buf); // EOF when the client closes
        *closed.lock().unwrap() = Some(Instant::now());
    });
    (port, sent, closed_at)
}

#[test]
fn fetch_exit_interrupts_a_body_read() {
    let (port, sent, closed_at) = stalled_body_server();
    let mut core = NetCore::new(FetchTransport::default());
    core.start(
        &fetch_meta(
            &format!("http://127.0.0.1:{port}/slow"),
            "GET",
            60_000,
            4096,
        ),
        b"",
    );
    wait_for(&sent);
    thread::sleep(Duration::from_millis(50)); // the worker is blocked in read
    let started = Instant::now();
    drop(core);
    let dropped = Instant::now();
    eprintln!("drop took {:?}", dropped - started);
    assert!(dropped - started < INTERRUPT, "{:?}", dropped - started);
    assert_closed_by(&closed_at, dropped);
}

#[test]
fn fetch_cancel_interrupts_a_body_read() {
    let (port, sent, closed_at) = stalled_body_server();
    let mut core = NetCore::new(FetchTransport::default());
    let handle = core.start(
        &fetch_meta(
            &format!("http://127.0.0.1:{port}/slow"),
            "GET",
            60_000,
            4096,
        ),
        b"",
    );
    wait_for(&sent);
    let cancelled = Instant::now();
    core.cancel(handle);
    let deadline = Instant::now() + Duration::from_secs(2);
    while closed_at.lock().unwrap().is_none() {
        assert!(Instant::now() < deadline, "cancel left the TCP stream open");
        thread::sleep(Duration::from_millis(2));
    }
    let closed = closed_at.lock().unwrap().unwrap();
    eprintln!("cancel() to server-seen close {:?}", closed - cancelled);
    assert!(closed - cancelled < INTERRUPT, "{:?}", closed - cancelled);
    core.begin_tick();
    assert!(core.poll().is_none(), "a cancelled request reports nothing");
}

#[test]
fn fetch_exit_interrupts_a_tls_handshake() {
    let (port, accepted, closed_at) = silent_tcp_server();
    let mut core = NetCore::new(FetchTransport::default());
    core.start(
        &fetch_meta(&format!("https://127.0.0.1:{port}/"), "GET", 60_000, 64),
        b"",
    );
    wait_for(&accepted);
    thread::sleep(Duration::from_millis(50)); // ClientHello sent, no answer
    let started = Instant::now();
    drop(core);
    let dropped = Instant::now();
    eprintln!("drop took {:?}", dropped - started);
    assert!(dropped - started < INTERRUPT, "{:?}", dropped - started);
    assert_closed_by(&closed_at, dropped);
}

#[test]
fn fetch_reads_chunked_bodies_and_skips_interim_responses() {
    let port = http_server(|request| {
        Some(match request.path.as_str() {
            "/chunked" => b"HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nx-trailer: t\r\n\r\n".to_vec(),
            "/eof" => b"HTTP/1.1 200 OK\r\nconnection: close\r\n\r\nuntil eof".to_vec(),
            "/big-chunks" => b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\n0123456789abcdef\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n".to_vec(),
            "/short" => b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc".to_vec(),
            "/garbage" => b"NOT HTTP\r\n\r\n".to_vec(),
            _ => http_response("404 Not Found", &[], b""),
        })
    });
    let base = format!("http://127.0.0.1:{port}");
    let mut core = NetCore::new(FetchTransport::default());

    let h = core.start(
        &fetch_meta(&format!("{base}/chunked"), "GET", 5_000, 64),
        b"",
    );
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(events[0]["status"], 200, "{events:?}");
    assert_eq!(events[0]["headers"]["set-cookie"], "a=1, b=2");
    assert_eq!(core.take(h).unwrap(), b"hello world");

    let h = core.start(&fetch_meta(&format!("{base}/eof"), "GET", 5_000, 64), b"");
    net_events(&mut core, Duration::from_secs(5));
    assert_eq!(core.take(h).unwrap(), b"until eof");

    core.start(
        &fetch_meta(&format!("{base}/big-chunks"), "GET", 5_000, 20),
        b"",
    );
    let events = net_events(&mut core, Duration::from_secs(5));
    assert_eq!(
        events[0]["code"],
        net_spec::ERROR_RESPONSE_TOO_LARGE,
        "{events:?}"
    );

    for path in ["/short", "/garbage"] {
        core.start(&fetch_meta(&format!("{base}{path}"), "GET", 5_000, 64), b"");
        let events = net_events(&mut core, Duration::from_secs(5));
        assert_eq!(
            events[0]["code"],
            net_spec::ERROR_PROTOCOL,
            "{path}: {events:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// WebSocket fixture
// ---------------------------------------------------------------------------

/// Echo server: text and binary come back unchanged; "close-me" closes with
/// 4001 "bye"; "big" answers with a message over the contract limit; "flood"
/// streams 4 KiB binaries until the peer goes away. Every received close code
/// is recorded.
fn ws_server(closes: Arc<std::sync::Mutex<Vec<u16>>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { break };
            let closes = closes.clone();
            thread::spawn(move || serve_ws(stream, closes));
        }
    });
    port
}

#[allow(clippy::result_large_err)] // tungstenite's handshake callback signature
fn serve_ws(stream: TcpStream, closes: Arc<std::sync::Mutex<Vec<u16>>>) {
    let callback = |request: &Request, mut response: Response| {
        if request.uri().path() == "/missing" {
            let mut refused = tungstenite::handshake::server::ErrorResponse::new(None);
            *refused.status_mut() = tungstenite::http::StatusCode::NOT_FOUND;
            return Err(refused);
        }
        if let Some(offer) = request.headers().get("sec-websocket-protocol")
            && offer.to_str().unwrap().split(", ").any(|p| p == "zone.v1")
        {
            response
                .headers_mut()
                .insert("sec-websocket-protocol", "zone.v1".parse().unwrap());
        }
        Ok(response)
    };
    let Ok(mut socket) = tungstenite::accept_hdr(stream, callback) else {
        return;
    };
    loop {
        match socket.read() {
            Ok(Message::Text(text)) if text.as_str() == "close-me" => {
                let _ = socket.close(Some(CloseFrame {
                    code: CloseCode::from(4001),
                    reason: "bye".into(),
                }));
            }
            Ok(Message::Text(text)) if text.as_str() == "big" => {
                let _ = socket.send(Message::binary(vec![
                    0u8;
                    socket_spec::MAX_MESSAGE_BYTES + 1
                ]));
            }
            Ok(Message::Text(text)) if text.as_str() == "flood" => {
                while socket.send(Message::binary(vec![7u8; 4096])).is_ok() {}
                return;
            }
            Ok(Message::Close(frame)) => {
                closes
                    .lock()
                    .unwrap()
                    .push(frame.map_or(1005, |f| u16::from(f.code)));
            }
            Ok(message @ (Message::Text(_) | Message::Binary(_))) => {
                let _ = socket.send(message);
            }
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

const WS_META: &str = r#"{"protocols":["zone.v1"],"timeoutMs":5000}"#;

/// Tick until `done` holds over everything polled so far.
fn ws_events(
    core: &mut SocketCore<WsTransport>,
    within: Duration,
    done: impl Fn(&[Value]) -> bool,
) -> Vec<Value> {
    let deadline = Instant::now() + within;
    let mut all = Vec::new();
    while Instant::now() < deadline {
        core.begin_tick();
        if let Some(batch) = core.poll() {
            let events: Vec<Value> = serde_json::from_str(&batch).unwrap();
            for event in events {
                if event["t"] == "message" && event["text"] == false {
                    let id = event["m"].as_i64().unwrap() as i32;
                    let body = core.take(id).unwrap();
                    let mut event = event;
                    event["body"] = Value::from(body);
                    all.push(event);
                } else {
                    all.push(event);
                }
            }
            if done(&all) {
                return all;
            }
        }
        thread::sleep(Duration::from_millis(1));
    }
    panic!("condition not reached within {within:?}: {all:?}");
}

fn has(events: &[Value], kind: &str) -> bool {
    events.iter().any(|e| e["t"] == kind)
}

#[test]
fn websocket_round_trips_text_and_binary_and_negotiates_the_protocol() {
    let closes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let port = ws_server(closes.clone());
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    assert!(handle > 0, "{}", core.last_error());
    let opened = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    assert_eq!(opened[0]["protocol"], "zone.v1");
    assert!(core.send(handle, "héllo".as_bytes(), true) > 0);
    assert!(core.send(handle, &[1, 2, 3], false) > 0);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| e.len() >= 2);
    assert_eq!(events[0]["data"], "héllo");
    assert_eq!(events[1]["body"], serde_json::json!([1, 2, 3]));
    // Written bytes are credited back so the queue drains to empty.
    thread::sleep(Duration::from_millis(50));
    core.begin_tick();
    assert_eq!(
        core.send(handle, b"x", false) as usize,
        1 + socket_spec::MESSAGE_OVERHEAD_BYTES
    );

    assert_eq!(core.close(handle, 1000, "done"), 0);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    let close = events.iter().find(|e| e["t"] == "close").unwrap();
    assert_eq!(close["code"], 1000);
    assert_eq!(close["clean"], true);
    assert_eq!(*closes.lock().unwrap(), vec![1000]);
    assert_eq!(core.live(), 0);
}

#[test]
fn websocket_reports_server_close_and_failures_as_events() {
    let closes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let port = ws_server(closes);
    let mut core = SocketCore::new(WsTransport::default());

    let handle = core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    core.send(handle, b"close-me", true);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    let close = events.last().unwrap();
    assert_eq!(
        (&close["code"], &close["reason"], &close["clean"]),
        (&Value::from(4001), &Value::from("bye"), &Value::from(true))
    );

    let handle = core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    core.send(handle, b"big", true);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(
        events[0]["code"],
        socket_spec::ERROR_MESSAGE_TOO_LARGE,
        "{events:?}"
    );
    assert_eq!(events[1]["code"], socket_spec::CLOSE_MESSAGE_TOO_BIG);
    assert_eq!(events[1]["clean"], false);

    core.open(&format!("ws://127.0.0.1:{port}/missing"), WS_META);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(
        events[0]["code"],
        socket_spec::ERROR_HANDSHAKE,
        "{events:?}"
    );
    assert_eq!(events[1]["code"], socket_spec::CLOSE_ABNORMAL);

    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead = closed.local_addr().unwrap().port();
    drop(closed);
    core.open(&format!("ws://127.0.0.1:{dead}/"), WS_META);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(events[0]["code"], socket_spec::ERROR_CONNECT, "{events:?}");
    assert_eq!(events[1]["code"], socket_spec::CLOSE_ABNORMAL);
}

#[test]
fn websocket_open_times_out_against_a_silent_server() {
    // Accepts TCP and never answers the upgrade.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let hold = Arc::new(AtomicBool::new(true));
    let held = hold.clone();
    thread::spawn(move || {
        let _streams: Vec<_> = listener.incoming().take(1).collect();
        while held.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(10));
        }
    });
    let mut core = SocketCore::new(WsTransport::default());
    let started = Instant::now();
    core.open(
        &format!("ws://127.0.0.1:{port}/"),
        r#"{"protocols":[],"timeoutMs":300}"#,
    );
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(events[0]["code"], socket_spec::ERROR_TIMEOUT, "{events:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    hold.store(false, Ordering::Relaxed);
}

#[test]
fn websocket_stops_reading_when_the_guest_falls_behind() {
    let closes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let port = ws_server(closes);
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    core.send(handle, b"flood", true);
    core.begin_tick(); // hand the command over; then the guest stalls
    thread::sleep(Duration::from_millis(500));
    // The I/O thread never holds more than the receive budget.
    let held = core.transport_mut().undelivered(handle);
    assert!(
        held <= socket_spec::MAX_RECV_QUEUE_BYTES,
        "transport buffered {held} bytes"
    );
    assert!(
        held >= socket_spec::MAX_RECV_QUEUE_BYTES / 2,
        "flood did not arrive: {held}"
    );
    // Each tick admits the held messages, at most the per-tick budget.
    let held_messages = held / (4096 + socket_spec::MESSAGE_OVERHEAD_BYTES);
    core.begin_tick();
    let batch: Vec<Value> = serde_json::from_str(&core.poll().unwrap()).unwrap();
    assert_eq!(
        batch.len(),
        held_messages.min(socket_spec::MAX_EVENTS_PER_TICK)
    );
    let started = Instant::now();
    drop(core);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn websocket_host_exit_sends_going_away_and_joins_threads() {
    let closes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let port = ws_server(closes.clone());
    let mut core = SocketCore::new(WsTransport::default());
    core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    let started = Instant::now();
    drop(core);
    assert!(started.elapsed() < Duration::from_secs(2));
    let deadline = Instant::now() + Duration::from_secs(2);
    while closes.lock().unwrap().is_empty() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(*closes.lock().unwrap(), vec![1001]);
}

static WS_LOOKUPS_DONE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn slow_ws_resolve(host: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
    thread::sleep(Duration::from_millis(1500));
    WS_LOOKUPS_DONE.fetch_add(1, Ordering::AcqRel);
    std::net::ToSocketAddrs::to_socket_addrs(&(host, port)).map(Iterator::collect)
}

#[test]
fn websocket_drop_during_the_handshake_joins_the_thread_and_closes_tcp() {
    let (port, accepted, closed_at) = silent_tcp_server();
    let mut core = SocketCore::new(WsTransport::default());
    core.open(
        &format!("ws://127.0.0.1:{port}/"),
        r#"{"protocols":[],"timeoutMs":30000}"#,
    );
    wait_for(&accepted);
    let started = Instant::now();
    drop(core);
    let dropped = Instant::now();
    eprintln!("drop took {:?}", dropped - started);
    assert!(dropped - started < INTERRUPT, "{:?}", dropped - started);
    assert_closed_by(&closed_at, dropped);
}

#[test]
fn websocket_dns_is_bounded_by_the_open_deadline_and_abandoned_on_drop() {
    let before = WS_LOOKUPS_DONE.load(Ordering::Acquire);
    let mut core = SocketCore::new(WsTransport::with_resolver(slow_ws_resolve));
    let started = Instant::now();
    core.open("ws://localhost:9/", r#"{"protocols":[],"timeoutMs":200}"#);
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(events[0]["code"], socket_spec::ERROR_TIMEOUT, "{events:?}");
    assert!(
        started.elapsed() < Duration::from_millis(1000),
        "{:?}",
        started.elapsed()
    );
    let dropping = Instant::now();
    drop(core);
    assert_lookup_abandoned(&WS_LOOKUPS_DONE, before, dropping.elapsed());
}

#[test]
fn websocket_close_while_connecting_reports_only_the_close() {
    // Closed during DNS: the attempt is abandoned at once.
    let mut core = SocketCore::new(WsTransport::with_resolver(slow_ws_resolve));
    let handle = core.open("ws://localhost:9/", r#"{"protocols":[],"timeoutMs":5000}"#);
    core.close(handle, 1000, "cancel");
    let started = Instant::now();
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert!(started.elapsed() < Duration::from_millis(500));
    assert_eq!(
        events,
        vec![serde_json::json!({"t":"close","h":handle,"code":1006,"reason":"","clean":false})]
    );
    // Closed while the upgrade is unanswered: the same single close.
    let (port, accepted, _closed) = silent_tcp_server();
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(
        &format!("ws://127.0.0.1:{port}/"),
        r#"{"protocols":[],"timeoutMs":300}"#,
    );
    wait_for(&accepted);
    core.close(handle, 1000, "cancel");
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    assert_eq!(
        events,
        vec![serde_json::json!({"t":"close","h":handle,"code":1006,"reason":"","clean":false})]
    );
}

/// Opens with a 60 s timeout, closes once `ready` holds and expects the one
/// `close(1006, clean=false)` within INTERRUPT; the server must see the TCP
/// stream (if any) closed by then.
fn assert_close_interrupts(
    url: &str,
    ready: impl Fn() -> bool,
    closed_at: Option<&std::sync::Mutex<Option<Instant>>>,
) {
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(url, r#"{"protocols":[],"timeoutMs":60000}"#);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "never reached the phase under test"
        );
        thread::sleep(Duration::from_millis(2));
    }
    thread::sleep(Duration::from_millis(50)); // the thread is blocked there
    let started = Instant::now();
    core.close(handle, 1000, "cancel");
    let events = ws_events(&mut core, Duration::from_secs(5), |e| has(e, "close"));
    let took = started.elapsed();
    eprintln!("{url}: close() to close event {took:?}");
    assert!(took < INTERRUPT, "close took {took:?}");
    assert_eq!(
        events,
        vec![serde_json::json!({"t":"close","h":handle,"code":1006,"reason":"","clean":false})]
    );
    if let Some(closed_at) = closed_at {
        assert_closed_by(closed_at, Instant::now());
    }
    let dropping = Instant::now();
    drop(core);
    assert!(dropping.elapsed() < INTERRUPT);
}

#[test]
fn websocket_close_interrupts_an_unanswered_upgrade() {
    let (port, accepted, closed_at) = silent_tcp_server();
    assert_close_interrupts(
        &format!("ws://127.0.0.1:{port}/"),
        || accepted.load(Ordering::Acquire),
        Some(&closed_at),
    );
}

#[test]
fn websocket_close_interrupts_a_tls_handshake() {
    let (port, accepted, closed_at) = silent_tcp_server();
    assert_close_interrupts(
        &format!("wss://127.0.0.1:{port}/"),
        || accepted.load(Ordering::Acquire),
        Some(&closed_at),
    );
}

/// A listener whose accept queue is full: further SYNs are dropped, so a
/// connect to it stays in progress. Returns None where the kernel does not
/// behave that way.
#[cfg(target_os = "linux")]
fn unanswered_syn_port() -> Option<(TcpListener, Vec<TcpStream>, u16)> {
    use std::os::fd::AsRawFd;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    // SAFETY: re-listen on a socket this function owns, with backlog 0.
    unsafe { libc::listen(listener.as_raw_fd(), 0) };
    let port = listener.local_addr().unwrap().port();
    let addr = listener.local_addr().unwrap();
    let mut held = Vec::new();
    for _ in 0..16 {
        match TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
            Ok(stream) => held.push(stream),
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                return Some((listener, held, port));
            }
            Err(_) => return None,
        }
    }
    None
}

#[cfg(target_os = "linux")]
#[test]
fn websocket_close_interrupts_a_tcp_connect() {
    let Some((_listener, _held, port)) = unanswered_syn_port() else {
        eprintln!("skipped: the accept queue never filled");
        return;
    };
    let opened = Instant::now();
    assert_close_interrupts(
        &format!("ws://127.0.0.1:{port}/"),
        || opened.elapsed() > Duration::from_millis(100),
        None,
    );
    // Host exit in the same phase.
    let mut core = SocketCore::new(WsTransport::default());
    core.open(
        &format!("ws://127.0.0.1:{port}/"),
        r#"{"protocols":[],"timeoutMs":60000}"#,
    );
    thread::sleep(Duration::from_millis(150));
    let started = Instant::now();
    drop(core);
    eprintln!("drop during TCP connect took {:?}", started.elapsed());
    assert!(started.elapsed() < INTERRUPT, "{:?}", started.elapsed());
}

#[test]
fn websocket_empty_messages_are_charged_both_ways() {
    let closes = Arc::new(std::sync::Mutex::new(Vec::new()));
    let port = ws_server(closes);
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(&format!("ws://127.0.0.1:{port}/ws"), WS_META);
    ws_events(&mut core, Duration::from_secs(5), |e| has(e, "open"));
    let limit = socket_spec::MAX_SEND_QUEUE_BYTES / socket_spec::MESSAGE_OVERHEAD_BYTES;
    let accepted = (0..100_000)
        .filter(|_| core.send(handle, b"", false) >= 0)
        .count();
    assert_eq!(accepted, limit);
    assert!(
        core.last_error()
            .starts_with(socket_spec::ERROR_BACKPRESSURE)
    );
    // The echoes come back as charged empty messages, never past the budget.
    let mut echoed = 0;
    let deadline = Instant::now() + Duration::from_secs(10);
    while echoed < limit && Instant::now() < deadline {
        assert!(core.transport_mut().undelivered(handle) <= socket_spec::MAX_RECV_QUEUE_BYTES);
        core.begin_tick();
        if let Some(batch) = core.poll() {
            let events: Vec<Value> = serde_json::from_str(&batch).unwrap();
            echoed += events.iter().filter(|e| e["t"] == "message").count();
        }
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(echoed, limit);
    // Written messages were credited: the queue accepts again.
    assert!(core.send(handle, b"", false) >= 0, "{}", core.last_error());
}

#[test]
fn mounted_guest_sees_both_namespaces() {
    let guest = Guest::new().unwrap();
    let _network = Network::mount(&guest).unwrap();
    guest
        .eval(
            "probe",
            r#"globalThis.ops = [typeof net.start, typeof net.take, typeof net.cancel,
                 typeof net.poll, typeof net.lastError, typeof socket.open,
                 typeof socket.send, typeof socket.close, typeof socket.poll,
                 typeof socket.take, typeof socket.lastError].join();"#,
        )
        .unwrap();
    let ops: String = guest.with(|ctx| ctx.globals().get("ops").unwrap());
    assert_eq!(ops, ["function"; 11].join(","));
}

/// Public-host checks reach the Internet, so they run only on request:
/// `POCKET_NET_PUBLIC=1 cargo test --release _public_`.
fn public_hosts_enabled() -> bool {
    let enabled = std::env::var_os("POCKET_NET_PUBLIC").is_some();
    if !enabled {
        eprintln!("skipped: set POCKET_NET_PUBLIC=1 to reach public hosts");
    }
    enabled
}

/// wss:// through rustls and the webpki roots against a public echo server.
#[test]
fn wss_public_echo_round_trip() {
    if !public_hosts_enabled() {
        return;
    }
    let mut core = SocketCore::new(WsTransport::default());
    let handle = core.open(
        "wss://echo.websocket.org/",
        r#"{"protocols":[],"timeoutMs":10000}"#,
    );
    let events = ws_events(&mut core, Duration::from_secs(15), |e| {
        has(e, "open") || has(e, "close")
    });
    assert!(has(&events, "open"), "{events:?}");
    core.send(handle, b"pocket-wss", true);
    let events = ws_events(&mut core, Duration::from_secs(15), |e| {
        e.iter().any(|m| m["data"] == "pocket-wss")
    });
    assert!(!events.is_empty());
    core.close(handle, 1000, "");
    ws_events(&mut core, Duration::from_secs(15), |e| has(e, "close"));
}

/// https:// through rustls against a public host.
#[test]
fn https_public_fetch() {
    if !public_hosts_enabled() {
        return;
    }
    let mut core = NetCore::new(FetchTransport::default());
    let handle = core.start(
        &fetch_meta("https://example.com/", "GET", 15_000, 64 * 1024),
        b"",
    );
    let events = net_events(&mut core, Duration::from_secs(20));
    assert_eq!(events[0]["t"], "done", "{events:?}");
    assert_eq!(events[0]["status"], 200);
    let body = core.take(handle).unwrap();
    assert!(String::from_utf8_lossy(&body).contains("Example Domain"));
}
