//! Cancellable DNS and TCP connect for the net.http and net.socket
//! transports.
//!
//! DNS runs on a helper thread; the caller polls it every `POLL` against its
//! deadline and cancellation and abandons it when either fires. `getaddrinfo`
//! cannot be interrupted, so an abandoned lookup keeps running until the
//! system resolver returns (glibc: `timeout` x `attempts` per nameserver from
//! resolv.conf, 5 s x 2 by default). It owns no socket. Abandoned lookups are
//! counted in `Lookups` so a transport can refuse new work while too many are
//! still running; a dropped transport does not wait for them.
//!
//! TCP connects on a non-blocking socket and polls for completion every
//! `POLL`, so cancellation ends a connect attempt within one poll interval.
//! The returned stream is blocking.
use std::{
    io,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        Arc, Mutex,
        mpsc::{RecvTimeoutError, channel},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

/// Latency bound for noticing cancellation while resolving or connecting.
const POLL: Duration = Duration::from_millis(5);

/// Resolver run on the DNS helper thread; replaceable in tests.
pub type Resolve = fn(&str, u16) -> io::Result<Vec<SocketAddr>>;

pub fn system_resolve(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    Ok((host, port).to_socket_addrs()?.collect())
}

/// DNS helper threads whose caller stopped waiting for them.
#[derive(Clone, Default)]
pub struct Lookups(Arc<Mutex<Vec<JoinHandle<()>>>>);

impl Lookups {
    /// Joins finished lookups; returns how many are still running.
    pub fn reap(&self) -> usize {
        let mut lookups = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut i = 0;
        while i < lookups.len() {
            if lookups[i].is_finished() {
                let _ = lookups.swap_remove(i).join();
            } else {
                i += 1;
            }
        }
        lookups.len()
    }

    fn push(&self, thread: JoinHandle<()>) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(thread);
    }
}

pub enum DialError {
    Cancelled,
    Timeout(String),
    Dns(String),
    Connect(String),
    Other(String),
}

/// One connection attempt: the deadline covers DNS and every address tried.
pub struct Dial<'a> {
    pub deadline: Instant,
    pub cancelled: &'a dyn Fn() -> bool,
    pub resolve: Resolve,
    pub lookups: &'a Lookups,
}

impl Dial<'_> {
    pub fn connect(&self, host: &str, port: u16) -> Result<TcpStream, DialError> {
        let addrs = self.lookup(host, port)?;
        let mut last = String::new();
        for addr in &addrs {
            match self.connect_addr(addr) {
                Ok(stream) => return Ok(stream),
                Err(DialError::Connect(message)) => last = format!("connect {addr}: {message}"),
                Err(other) => return Err(other),
            }
        }
        Err(DialError::Connect(last))
    }

    /// Time left before the deadline, or a timeout error.
    fn left(&self, what: &str) -> Result<Duration, DialError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(DialError::Timeout(format!("{what} timed out")))
        } else {
            Ok(left)
        }
    }

    fn lookup(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, DialError> {
        let (tx, rx) = channel();
        let resolve = self.resolve;
        let name = host.to_string();
        let thread = thread::Builder::new()
            .name("pocket-dns".into())
            .spawn(move || {
                let _ = tx.send(resolve(&name, port));
            })
            .map_err(|e| DialError::Other(format!("thread spawn: {e}")))?;
        let outcome = loop {
            if (self.cancelled)() {
                break Err(DialError::Cancelled);
            }
            let left = match self.left(&format!("{host}: DNS")) {
                Ok(left) => left,
                Err(timeout) => break Err(timeout),
            };
            match rx.recv_timeout(left.min(POLL)) {
                Ok(Ok(addrs)) if addrs.is_empty() => {
                    break Err(DialError::Dns(format!("{host}: no addresses")));
                }
                Ok(Ok(addrs)) => break Ok(addrs),
                Ok(Err(e)) => break Err(DialError::Dns(format!("{host}: {e}"))),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    break Err(DialError::Dns(format!("{host}: resolver failed")));
                }
            }
        };
        if thread.is_finished() {
            let _ = thread.join();
        } else {
            self.lookups.push(thread);
        }
        outcome
    }

    #[cfg(unix)]
    fn connect_addr(&self, addr: &SocketAddr) -> Result<TcpStream, DialError> {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        let os = |e: io::Error| DialError::Other(e.to_string());
        let check = |rc: libc::c_int| {
            if rc < 0 {
                Err(os(io::Error::last_os_error()))
            } else {
                Ok(rc)
            }
        };
        let domain = if addr.is_ipv4() {
            libc::AF_INET
        } else {
            libc::AF_INET6
        };
        // SAFETY: plain socket syscalls on a descriptor this function owns.
        unsafe {
            let fd = check(libc::socket(domain, libc::SOCK_STREAM, 0))?;
            let socket = OwnedFd::from_raw_fd(fd);
            check(libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC))?;
            let flags = check(libc::fcntl(fd, libc::F_GETFL))?;
            check(libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK))?;
            let (storage, len) = raw_addr(addr);
            let rc = libc::connect(fd, (&raw const storage).cast(), len);
            if rc != 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EINPROGRESS) {
                    return Err(DialError::Connect(error.to_string()));
                }
                loop {
                    if (self.cancelled)() {
                        return Err(DialError::Cancelled);
                    }
                    let left = self.left(&format!("connect {addr}"))?;
                    let mut pfd = libc::pollfd {
                        fd,
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    let wait = left.min(POLL).as_millis().max(1) as libc::c_int;
                    let ready = libc::poll(&mut pfd, 1, wait);
                    if ready > 0 {
                        break;
                    }
                    if ready < 0 {
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::Interrupted {
                            return Err(os(error));
                        }
                    }
                }
                let mut code: libc::c_int = 0;
                let mut size = size_of::<libc::c_int>() as libc::socklen_t;
                check(libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&raw mut code).cast(),
                    &mut size,
                ))?;
                if code != 0 {
                    return Err(DialError::Connect(
                        io::Error::from_raw_os_error(code).to_string(),
                    ));
                }
            }
            check(libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK))?;
            debug_assert_eq!(socket.as_raw_fd(), fd);
            Ok(TcpStream::from(socket))
        }
    }

    /// Without a non-blocking connect, cancellation waits for the attempt to
    /// end (bounded by the deadline).
    #[cfg(not(unix))]
    fn connect_addr(&self, addr: &SocketAddr) -> Result<TcpStream, DialError> {
        if (self.cancelled)() {
            return Err(DialError::Cancelled);
        }
        let left = self.left(&format!("connect {addr}"))?;
        TcpStream::connect_timeout(addr, left).map_err(|e| match e.kind() {
            io::ErrorKind::TimedOut => DialError::Timeout(format!("connect {addr}: {e}")),
            _ => DialError::Connect(e.to_string()),
        })
    }
}

#[cfg(unix)]
fn raw_addr(addr: &SocketAddr) -> (libc::sockaddr_storage, libc::socklen_t) {
    // SAFETY: sockaddr_storage is plain data, large enough for either family.
    let mut storage: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let len = match addr {
        SocketAddr::V4(v4) => {
            let sin = (&raw mut storage).cast::<libc::sockaddr_in>();
            unsafe {
                (*sin).sin_family = libc::AF_INET as libc::sa_family_t;
                (*sin).sin_port = v4.port().to_be();
                (*sin).sin_addr = libc::in_addr {
                    s_addr: u32::from_ne_bytes(v4.ip().octets()),
                };
            }
            size_of::<libc::sockaddr_in>()
        }
        SocketAddr::V6(v6) => {
            let sin6 = (&raw mut storage).cast::<libc::sockaddr_in6>();
            unsafe {
                (*sin6).sin6_family = libc::AF_INET6 as libc::sa_family_t;
                (*sin6).sin6_port = v6.port().to_be();
                (*sin6).sin6_flowinfo = v6.flowinfo();
                (*sin6).sin6_addr = libc::in6_addr {
                    s6_addr: v6.ip().octets(),
                };
                (*sin6).sin6_scope_id = v6.scope_id();
            }
            size_of::<libc::sockaddr_in6>()
        }
    };
    (storage, len as libc::socklen_t)
}
