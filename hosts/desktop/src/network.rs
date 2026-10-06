//! net.http and net.socket for one guest realm: the pocket-net and
//! pocket-socket cores over this host's worker-thread transports, mounted as
//! `globalThis.net` and `globalThis.socket`. Dropping it shuts the transport
//! threads down.
use anyhow::Result;
use pocket_mod::Guest;
use pocket_net::NetSurface;
use pocket_socket::SocketSurface;

use crate::{fetch::FetchTransport, websocket::WsTransport};

pub struct Network {
    net: NetSurface<FetchTransport>,
    socket: SocketSurface<WsTransport>,
}

impl Network {
    pub fn mount(guest: &Guest) -> Result<Self> {
        let net = NetSurface::new(FetchTransport::default());
        net.mount(guest)?;
        let socket = SocketSurface::new(WsTransport::default());
        socket.mount(guest)?;
        Ok(Self { net, socket })
    }

    /// Admit transport results; call once per tick before `guest.frame()`.
    pub fn begin_tick(&self) {
        self.net.begin_tick();
        self.socket.begin_tick();
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
