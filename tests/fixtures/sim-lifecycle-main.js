globalThis.__simLifecycleEval?.();

if (globalThis.__simLifecycleCreateFrameworkGlobals) {
  const marker = globalThis.__simLifecycleFrameworkMarker;
  for (const key of [
    "document",
    "window",
    "Node",
    "Element",
    "HTMLElement",
    "Text",
    "Comment",
    "__pocketjsNativeReturn",
  ]) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: marker,
    });
  }
}

if (globalThis.__simLifecycleMutateNestedGlobals) {
  const consoleObject = globalThis.console;
  consoleObject.__simLifecycleNested = globalThis.__simLifecycleFrameworkMarker;
  consoleObject.log = globalThis.__simLifecycleFrameworkMarker;
  consoleObject.__pocketBridge = {
    current: globalThis.__simLifecycleFrameworkMarker,
  };
  if (typeof globalThis.Node === "function") {
    Object.defineProperty(globalThis.Node, Symbol.hasInstance, {
      configurable: true,
      value: globalThis.__simLifecycleFrameworkMarker,
    });
  }
}

if (globalThis.__simLifecycleThrowDuringEval) {
  globalThis.__simLifecycleEvalLeak = globalThis.__simLifecycleFrameworkMarker;
  throw new Error("sim lifecycle fixture eval failed");
}

globalThis.frame = () => {};
