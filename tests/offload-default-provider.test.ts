import { expect, test } from "bun:test";
import { offload } from "../framework/src/offload.ts";

// The framework caches one client per provider per realm, so these tests are
// order-dependent: the companion-rejection test must run before any
// companion client is created in this file.

// The PSP host publishes globalThis.offload on every build so the
// device-local provider (the memory-stick font archive) is always available,
// but installs session/submit/take on the root object only while the USB
// companion is enabled.
function pspCompanionDisabled() {
  let session = 7;
  const sent: string[] = [];
  (globalThis as unknown as { offload: unknown }).offload = {
    local: {
      session: () => session,
      submit: (record: string) => { sent.push(record); return true; },
      take: () => undefined,
    },
  };
  return { sent, reconnect: () => { session = 9; } };
}

test("default offload() rejects a PSP host with the companion disabled", () => {
  pspCompanionDisabled();
  expect(() => offload()).toThrow("companion offload provider");
  // A rejected lookup must not cache a client: the same clear error repeats.
  expect(() => offload()).toThrow("companion offload provider");
});

test("offload(local) works on the same PSP host", () => {
  const host = pspCompanionDisabled();
  const client = offload("local");
  expect(client.session()).toBe(7);
  expect(client.connected()).toBe(true);
  let outcome: unknown;
  const id = client.request("file.read", '"font-archive.bin"', r => { outcome = r; });
  expect(id).toBeGreaterThan(0);
  client.step(); // submits the bounded record to the local provider
  expect(host.sent).toHaveLength(1);
  host.reconnect();
  client.step(); // the generation change must surface as a failed delivery
  expect(outcome).toMatchObject({ ok: false });
});

test("a host with a complete root keeps the companion default", () => {
  let session = 3;
  const replies: string[] = [];
  (globalThis as unknown as { offload: unknown }).offload = {
    session: () => session,
    submit: () => true,
    take: () => replies.shift(),
  };
  const client = offload();
  expect(client.session()).toBe(3);
  let outcome: unknown;
  const id = client.request("db.page", "{}", r => { outcome = r; });
  expect(id).toBeGreaterThan(0);
  client.step(); // submits
  replies.push(JSON.stringify({ id, payload: "[]" }));
  client.step(); // delivers
  expect(outcome).toEqual({ ok: true, value: "[]" });
});
