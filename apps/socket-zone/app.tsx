// apps/socket-zone/app.tsx — a WebSocket client for a zone server: join,
// send the held d-pad at 20 Hz, draw every player the server reports nearby.
//
// All network effects arrive through openSocket() callbacks, which the
// framework service pump runs once per tick before this component's frame
// hook. With no d-pad input for two seconds the client walks a small square
// so idle instances still move. Every 30 ticks the visible entity table is
// logged as `ZONE {...}` and published on globalThis.__zone for test drivers.

import { createSignal, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { platform } from "@pocketjs/framework/platform";
import { openSocket, type PocketSocket } from "@pocketjs/framework/socket";
import { decode, encodeInput, encodeJoin, type Entity } from "./protocol.ts";

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";
const TILE = 12; // px per tile on screen
const CENTER_X = 240;
const CENTER_Y = 150;
const DPAD = BTN.UP | BTN.RIGHT | BTN.DOWN | BTN.LEFT;
const AUTO = [BTN.RIGHT, BTN.DOWN, BTN.LEFT, BTN.UP];
const AUTO_LEG_TICKS = 40;
const RETRY_TICKS = 120;

const COLORS = [
  "#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#e2e8f0", "#facc15", "#4ade80", "#38bdf8", "#c084fc", "#fb7185", "#94a3b8",
];

function zoneUrl(): string {
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  if (search && typeof URLSearchParams === "function") {
    const fromQuery = new URLSearchParams(search).get("zone");
    if (fromQuery) return fromQuery;
  }
  return DEFAULT_URL;
}

export default function Zone() {
  const url = zoneUrl();
  const color = Date.now() % 16;
  const name = `${platform.target}-${Date.now() % 10000}`;
  const [status, setStatus] = createSignal("connecting");
  const [you, setYou] = createSignal(0);
  const [entities, setEntities] = createSignal<Entity[]>([]);
  const [frame, setFrame] = createSignal(0);

  let socket: PocketSocket | null = null;
  let retryAt = 0;
  let tick = 0;
  let idleTicks = 0;
  let lastSent = -1;

  function connect(): void {
    try {
      socket = openSocket(url, { timeoutMs: 5000 });
    } catch (error) {
      setStatus(`refused: ${(error as Error).message}`);
      socket = null;
      retryAt = tick + RETRY_TICKS;
      return;
    }
    setStatus("connecting");
    const current = socket;
    current.onOpen = () => {
      setStatus("open");
      current.send(encodeJoin(name, color));
    };
    current.onMessage = (data) => {
      if (typeof data === "string") return;
      const message = decode(data);
      if (!message) return;
      if (message.type === "welcome") setYou(message.you);
      else if (message.type === "state") {
        setFrame(message.frame);
        setEntities(message.entities);
      } else if (message.type === "bye") {
        setEntities(entities().filter((entity) => entity.id !== message.id));
      }
    };
    current.onError = (error) => setStatus(`${error.code}: ${error.message}`);
    current.onClose = (event) => {
      setStatus(`closed ${event.code}`);
      setEntities([]);
      socket = null;
      lastSent = -1;
      retryAt = tick + RETRY_TICKS;
    };
  }

  connect();

  onFrame((buttons) => {
    tick++;
    if (!socket && tick >= retryAt) connect();
    const held = buttons & DPAD;
    idleTicks = held ? 0 : idleTicks + 1;
    const walk = held || (idleTicks > 120 ? AUTO[Math.floor(tick / AUTO_LEG_TICKS) % AUTO.length] : 0);
    if (socket?.readyState === "open" && tick % 3 === 0 && (walk !== lastSent || tick % 30 === 0)) {
      if (socket.send(encodeInput(walk))) lastSent = walk;
    }
    if (tick % 30 === 0) {
      const table = {
        you: you(),
        frame: frame(),
        status: status(),
        ids: entities().map((entity) => entity.id),
      };
      (globalThis as { __zone?: unknown }).__zone = table;
      console.log(`ZONE ${JSON.stringify(table)}`);
    }
  });

  const self = () => entities().find((entity) => entity.id === you()) ?? entities()[0];

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: "#0b1220" }}>
      <View class="flex-row justify-between px-3 py-2" style={{ bgColor: "#111a2e" }}>
        <Text class="text-sm font-bold" style={{ textColor: "#e2e8f0" }}>
          {`ZONE  you #${you()}  ${status()}`}
        </Text>
        <Text class="text-sm" style={{ textColor: "#94a3b8" }}>
          {`${entities().length} nearby  f${frame()}`}
        </Text>
      </View>
      <View class="px-3 pt-1">
        <Text class="text-xs" style={{ textColor: "#64748b" }}>
          {`ids ${entities().map((entity) => entity.id).join(" ")}`}
        </Text>
      </View>
      <Index each={entities()}>
        {(entity) => {
          const left = () => {
            const me = self();
            return me
              ? CENTER_X + (entity().tx - me.tx) * TILE + Math.round(((entity().dx - me.dx) * TILE) / 16)
              : CENTER_X;
          };
          const top = () => {
            const me = self();
            return me
              ? CENTER_Y + (entity().ty - me.ty) * TILE + Math.round(((entity().dy - me.dy) * TILE) / 16)
              : CENTER_Y;
          };
          const mine = () => entity().id === you();
          return (
            <View
              class="absolute rounded-sm"
              style={{
                insetL: left() - 6,
                insetT: top() - 6,
                width: 12,
                height: 12,
                bgColor: COLORS[entity().color],
                borderColor: mine() ? "#ffffff" : COLORS[entity().color],
                borderWidth: mine() ? 2 : 0,
              }}
            />
          );
        }}
      </Index>
    </View>
  );
}
