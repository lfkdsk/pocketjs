import { expect, test } from "bun:test";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { createCanvasPresenter } from "../hosts/web/canvas-presenter.js";
import { createWasmUi, type WasmUi } from "../hosts/web/wasm-ops.js";
import { NODE_TYPE, PROP, ROOT_ID, abgr } from "../contracts/spec/spec.ts";

const WASM = new URL("../hosts/web/pocketjs.wasm", import.meta.url);
const DENSITY = 3;

type RecordingContext = CanvasRenderingContext2D & { readonly calls: number[] };

function recordingContext(canvas: Canvas): RecordingContext {
  const context = canvas.getContext("2d");
  const calls: number[] = [];
  return {
    calls,
    createImageData: context.createImageData.bind(context),
    putImageData(...args: unknown[]) {
      calls.push(args.length);
      return context.putImageData(...args as Parameters<typeof context.putImageData>);
    },
  } as unknown as RecordingContext;
}

async function core(width: number, height: number): Promise<WasmUi> {
  return createWasmUi(await Bun.file(WASM).arrayBuffer(), {
    width,
    height,
    rasterDensity: DENSITY,
  });
}

function installScene(wasm: WasmUi): number {
  const node = wasm.ops.createNode(NODE_TYPE.view);
  wasm.ops.setProp(ROOT_ID, PROP.bgColor, abgr(12, 18, 30));
  wasm.ops.setProp(node, PROP.posType, 1);
  wasm.ops.setProp(node, PROP.insetL, 1);
  wasm.ops.setProp(node, PROP.insetT, 2);
  wasm.ops.setProp(node, PROP.width, 4);
  // One logical row becomes three physical rows. Dropping the last copied row
  // leaves stale canvas pixels and breaks the per-frame equality below.
  wasm.ops.setProp(node, PROP.height, 1);
  wasm.ops.setProp(node, PROP.bgColor, abgr(244, 74, 96));
  wasm.ops.insertBefore(ROOT_ID, node, 0);
  return node;
}

test("full and dirty canvas uploads stay pixel-identical for one mutation tape", async () => {
  let width = 24;
  let height = 14;
  const oracle = await core(width, height);
  const subject = await core(width, height);
  const oracleNode = installScene(oracle);
  const subjectNode = installScene(subject);

  let oracleCanvas = createCanvas(width * DENSITY, height * DENSITY);
  let subjectCanvas = createCanvas(width * DENSITY, height * DENSITY);
  let oracleContext = recordingContext(oracleCanvas);
  let subjectContext = recordingContext(subjectCanvas);
  const full = createCanvasPresenter(oracleContext, oracleCanvas.width, oracleCanvas.height, { mode: "full" });
  const dirty = createCanvasPresenter(subjectContext, subjectCanvas.width, subjectCanvas.height);

  const pixels = (canvas: Canvas) =>
    canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  const compare = () => expect(pixels(subjectCanvas)).toEqual(pixels(oracleCanvas));
  const setBoth = (target: "node" | "root", prop: number, value: number) => {
    oracle.ops.setProp(target === "node" ? oracleNode : ROOT_ID, prop, value);
    subject.ops.setProp(target === "node" ? subjectNode : ROOT_ID, prop, value);
  };
  const present = () => {
    oracle.tick();
    subject.tick();
    full.present(oracle.renderScaled(DENSITY), null);
    const outcome = dirty.present(
      subject.renderScaledIncremental(DENSITY),
      subject.damageRects(DENSITY),
    );
    compare();
    return outcome;
  };

  // First frame restores the whole blank backing store.
  expect(present()).toBe(-1);
  expect(subjectContext.calls.at(-1)).toBe(3);

  // The tape moves a one-row shape. Old and new rows are separate dirty
  // regions, and each upload uses the seven-argument dirty overload.
  setBoth("node", PROP.insetL, 11);
  const callsBeforeMove = subjectContext.calls.length;
  expect(present()).toBeGreaterThan(0);
  expect(subjectContext.calls.slice(callsBeforeMove).every((count) => count === 7)).toBe(true);

  setBoth("node", PROP.insetT, 8);
  setBoth("node", PROP.bgColor, abgr(68, 210, 132));
  expect(present()).toBeGreaterThan(0);

  // A root background mutation covers more than the 75% damage policy and
  // must take the explicit full-upload overload, not a whole-screen dirty call.
  setBoth("root", PROP.bgColor, abgr(34, 48, 82));
  expect(present()).toBe(-1);
  expect(subjectContext.calls.at(-1)).toBe(3);

  // No DrawList change means no framebuffer copy and no canvas upload.
  const callsBeforeIdle = subjectContext.calls.length;
  expect(present()).toBe(0);
  expect(subjectContext.calls.length).toBe(callsBeforeIdle);

  // A restored 2D context has an empty backing store. Invalidation makes an
  // unchanged incremental frame restore every pixel before presentation.
  subjectCanvas = createCanvas(width * DENSITY, height * DENSITY);
  subjectContext = recordingContext(subjectCanvas);
  dirty.reset(subjectContext, subjectCanvas.width, subjectCanvas.height);
  expect(present()).toBe(-1);
  expect(subjectContext.calls).toEqual([3]);

  // Resizing clears both canvases and changes the core target identity. The
  // first frame at the new size is full and remains byte-identical.
  width = 28;
  height = 16;
  oracle.resizeViewport(width, height);
  subject.resizeViewport(width, height);
  oracleCanvas = createCanvas(width * DENSITY, height * DENSITY);
  subjectCanvas = createCanvas(width * DENSITY, height * DENSITY);
  oracleContext = recordingContext(oracleCanvas);
  subjectContext = recordingContext(subjectCanvas);
  full.reset(oracleContext, oracleCanvas.width, oracleCanvas.height);
  dirty.reset(subjectContext, subjectCanvas.width, subjectCanvas.height);
  expect(present()).toBe(-1);
  expect(subjectContext.calls).toEqual([3]);
});
