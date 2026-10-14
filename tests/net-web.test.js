import { expect, test } from "bun:test";

import { fetch as pocketFetch } from "../framework/src/net-api.ts";
import { runServicePumps } from "../framework/src/services.ts";
import { createNetHost } from "../hosts/web/net.js";

function browserResponse(url, body = "ok") {
  const response = new Response(body, { status: 200 });
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: url },
  });
  return response;
}

test("browser net adapter uses native fetch but delivers only at beginFrame", async () => {
  const calls = [];
  const host = createNetHost(async (url, options) => {
    calls.push({ url, options });
    return new Response("web transport", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  });
  globalThis.net = host.ns;
  try {
    let settled = false;
    const promise = pocketFetch("https://example.test/web", {
      headers: { "x-test": "1" },
      maxBytes: 64,
    }).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(0);
    runServicePumps();
    await Promise.resolve();
    expect(settled).toBe(false);

    host.beginFrame();
    runServicePumps();
    const response = await promise;
    expect(await response.text()).toBe("web transport");
    expect(calls).toHaveLength(1);
    expect(calls[0].options.credentials).toBe("omit");
    expect(calls[0].options.redirect).toBe("follow");
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter enforces response maxBytes while reading", async () => {
  const host = createNetHost(async () => new Response("12345"));
  globalThis.net = host.ns;
  try {
    const promise = pocketFetch("https://example.test/large", { maxBytes: 4 });
    await Bun.sleep(0);
    host.beginFrame();
    runServicePumps();
    await expect(promise).rejects.toMatchObject({ code: "response_too_large" });
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter accepts same-origin redirects and refuses final scheme or origin changes", async () => {
  const host = createNetHost(async (url) => {
    if (url.endsWith("/same")) return browserResponse("https://example.test/ok");
    if (url.endsWith("/scheme")) return browserResponse("http://example.test/ok");
    return browserResponse("https://other.test/ok");
  });
  globalThis.net = host.ns;
  try {
    const same = pocketFetch("https://example.test/same");
    const scheme = pocketFetch("https://example.test/scheme").then(() => null, (error) => error);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(0);
      host.beginFrame();
      runServicePumps();
    }
    expect(await (await same).text()).toBe("ok");
    expect(await scheme).toMatchObject({ code: "redirect", message: "redirect_scheme" });

    const origin = pocketFetch("https://example.test/origin").then(() => null, (error) => error);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(0);
      host.beginFrame();
      runServicePumps();
    }
    expect(await origin).toMatchObject({ code: "redirect", message: "redirect_origin" });
    const long = `https://example.test/${"a".repeat(2048)}`;
    await expect(pocketFetch(long)).rejects.toMatchObject({ code: "invalid_request" });
    expect(host.ns.start(JSON.stringify({ url: long, method: "GET", headers: {}, timeoutMs: 1000, maxBytes: 16 }), new ArrayBuffer(0))).toBe(-1);
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter fails a redirect to a URL over the limit", async () => {
  const calls = [];
  const long = `https://example.test/${"x".repeat(3000)}`;
  const host = createNetHost(async (url) => {
    calls.push(url);
    return browserResponse(long);
  });
  globalThis.net = host.ns;
  try {
    const outcome = pocketFetch("https://example.test/start").then(() => "done", (error) => error);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(0);
      host.beginFrame();
      runServicePumps();
    }
    expect(new TextEncoder().encode(long).byteLength).toBe(3021);
    expect(await outcome).toMatchObject({ code: "redirect", message: "redirect URL too long" });
    expect(calls).toEqual(["https://example.test/start"]);
  } finally {
    host.reset();
    delete globalThis.net;
  }
});

test("browser net adapter fails a final response URL over the limit", async () => {
  const host = createNetHost(async () => {
    const response = new Response("ok");
    Object.defineProperty(response, "url", { value: `https://example.test/${"y".repeat(2048)}` });
    return response;
  });
  globalThis.net = host.ns;
  try {
    const outcome = pocketFetch("https://example.test/short").then(() => "done", (error) => error);
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(0);
      host.beginFrame();
      runServicePumps();
    }
    expect(await outcome).toMatchObject({ code: "redirect", message: "response URL too long" });
  } finally {
    host.reset();
    delete globalThis.net;
  }
});
