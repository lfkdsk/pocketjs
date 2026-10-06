// apps/socket-zone/protocol.ts — client side of a small zone-server wire
// protocol, kept as a local copy so the example has no server dependency.
//
// Client -> server:
//   text   {"type":"join","name":string,"color":0..15}   first message
//   binary [0x01, buttons u16 LE]                         held d-pad mask
// Server -> client (binary, little-endian, byte 0 = type):
//   0x10 WELCOME [you u32][seed u32][x0 i32][y0 i32][grid…]
//   0x20 STATE   [frame u32][n u8] then n × 10-byte entities:
//                [id u32][tx u8][ty u8][dx i8][dy i8][dir u8][flags u8]
//                flags bit 0 = moving, bits 1..4 = color
//   0x40 BYE     [id u32]
// STATE lists the viewer first, then others inside the area of interest.

export const MSG = { input: 0x01, welcome: 0x10, state: 0x20, bye: 0x40 } as const;
export const ENTITY_BYTES = 10;

export interface Entity {
  id: number;
  tx: number;
  ty: number;
  dx: number;
  dy: number;
  dir: number;
  moving: boolean;
  color: number;
}

export function encodeJoin(name: string, color: number): string {
  return JSON.stringify({ type: "join", name, color: color & 0x0f });
}

export function encodeInput(buttons: number): Uint8Array {
  const out = new Uint8Array(3);
  out[0] = MSG.input;
  out[1] = buttons & 0xff;
  out[2] = (buttons >> 8) & 0xff;
  return out;
}

export type ServerMessage =
  | { type: "welcome"; you: number }
  | { type: "state"; frame: number; entities: Entity[] }
  | { type: "bye"; id: number }
  | null;

export function decode(bytes: Uint8Array): ServerMessage {
  if (bytes.byteLength < 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case MSG.welcome:
      return bytes.byteLength >= 5 ? { type: "welcome", you: view.getUint32(1, true) } : null;
    case MSG.bye:
      return bytes.byteLength >= 5 ? { type: "bye", id: view.getUint32(1, true) } : null;
    case MSG.state: {
      if (bytes.byteLength < 6) return null;
      const n = bytes[5];
      if (bytes.byteLength < 6 + n * ENTITY_BYTES) return null;
      const entities: Entity[] = [];
      for (let i = 0; i < n; i++) {
        const o = 6 + i * ENTITY_BYTES;
        const flags = bytes[o + 9];
        entities.push({
          id: view.getUint32(o, true),
          tx: bytes[o + 4],
          ty: bytes[o + 5],
          dx: view.getInt8(o + 6),
          dy: view.getInt8(o + 7),
          dir: bytes[o + 8],
          moving: (flags & 1) !== 0,
          color: (flags >> 1) & 0x0f,
        });
      }
      return { type: "state", frame: view.getUint32(1, true), entities };
    }
    default:
      return null;
  }
}
