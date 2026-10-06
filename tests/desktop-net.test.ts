// The desktop host's net.http and net.socket against a local Bun server: the
// release binary runs tests/fixtures/desktop-net-probe.ts headless and the
// test reads its PROBE lines. Needs a built host
// (`cargo build --release --manifest-path hosts/desktop/Cargo.toml`). Local
// runs skip when the binary is absent; under CI a missing binary fails.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BIN = join(ROOT, "hosts/desktop/target/release/pocket-desktop-host");

if (process.env.CI && !existsSync(BIN)) {
  throw new Error(`desktop-net: ${BIN} is missing; build the release host first`);
}

describe.skipIf(!existsSync(BIN))("desktop host net + socket", () => {
  let server: ReturnType<typeof Bun.serve>;
  let dir = "";
  let probes: Array<Record<string, unknown>> = [];
  let exitCode = -1;
  const closes: number[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pocket-desktop-net-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const offered = req.headers.get("sec-websocket-protocol") ?? "";
          const headers = offered.split(/,\s*/).includes("probe.v1")
            ? { "sec-websocket-protocol": "probe.v1" }
            : undefined;
          return srv.upgrade(req, { headers, data: undefined }) ? undefined : new Response("no upgrade", { status: 400 });
        }
        if (url.pathname === "/hello") {
          return new Response("hi from bun", { headers: { "X-Bun": "yes" } });
        }
        if (url.pathname === "/redirect") return Response.redirect("/hello", 302);
        if (url.pathname === "/scheme") return Response.redirect("https://127.0.0.1:1/", 302);
        if (url.pathname === "/echo") return new Response(req.body);
        return new Response("missing", { status: 404 });
      },
      websocket: {
        message(ws, message) {
          if (message === "close-me") ws.close(4001, "bye");
          else ws.send(message);
        },
        close(_ws, code) {
          closes.push(code);
        },
      },
    });
    const origin = `127.0.0.1:${server.port}`;
    const build = await Bun.build({
      entrypoints: [join(ROOT, "tests/fixtures/desktop-net-probe.ts")],
      target: "browser",
      format: "iife",
      define: { __PROBE_ORIGIN__: JSON.stringify(origin) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    await Bun.write(join(dir, "probe.js"), await build.outputs[0].text());
    // Any valid pak serves: the probe draws nothing.
    const pak = Bun.spawnSync(
      ["bun", "tools/build.ts", "socket-zone-main", `--outdir=${dir}`],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    if (pak.exitCode !== 0) throw new Error(pak.stderr.toString());
    // Run the host on its own; awaiting a Bun.spawn while the same process
    // serves its requests keeps the server's event loop free.
    const host = Bun.spawn(
      [BIN, "--headless", "--app", "desktop-net-probe", "--js", join(dir, "probe.js"),
        "--pak", join(dir, "socket-zone-main.pak"), "--viewport", "480x272", "--fixed",
        "--density", "1", "--data-root", join(dir, "data"), "--quit-after", "180"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, RUST_LOG: "info" } },
    );
    const log = await new Response(host.stderr).text();
    exitCode = await host.exited;
    probes = log
      .split("\n")
      .filter((line) => line.includes("PROBE "))
      .map((line) => JSON.parse(line.slice(line.indexOf("PROBE ") + 6)));
  }, 60_000);

  afterAll(() => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const probe = (name: string) => probes.filter((p) => p.name === name);

  test("the headless host exits cleanly after its tick budget", () => {
    expect(exitCode).toBe(0);
  });

  test("fetch results arrive inside a guest frame, never during bundle eval", () => {
    const [get] = probe("get");
    expect(get).toMatchObject({ ok: true, value: { status: 200, header: "yes", text: "hi from bun" } });
    expect(get.tick as number).toBeGreaterThanOrEqual(1);
    expect(probe("post")[0]).toMatchObject({ ok: true, value: [1, 2, 3] });
  });

  test("same-scheme redirects are followed and scheme changes refused", () => {
    expect(probe("redirect")[0]).toMatchObject({
      ok: true,
      value: { url: `http://127.0.0.1:${server.port}/hello`, text: "hi from bun" },
    });
    expect(probe("scheme")[0]).toMatchObject({ ok: false, code: "redirect" });
  });

  test("a third concurrent fetch is refused with busy", () => {
    expect(probe("busy")[0]).toMatchObject({ ok: false, code: "busy" });
  });

  test("a WebSocket opens, echoes text and binary, and reports the server close", () => {
    expect(probe("open")[0]).toMatchObject({ protocol: "probe.v1" });
    expect(probe("message").map((p) => p.data)).toEqual(["hello", [9, 8, 7]]);
    expect(probe("close")).toHaveLength(1);
    expect(probe("close")[0]).toMatchObject({ code: 4001, reason: "bye", clean: true });
    // Every event is delivered at a tick after the open, in order.
    const ticks = [...probe("open"), ...probe("message"), ...probe("close")].map((p) => p.tick as number);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });
});
