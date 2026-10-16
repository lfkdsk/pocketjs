// Retained ImageData presentation for software-raster Web hosts. The core
// framebuffer and this ImageData both retain previous pixels; copy and upload
// only the logical damage rectangles emitted by the most recent render.

function dimension(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/**
 * @param {CanvasRenderingContext2D | any} initialContext
 * @param {number} initialWidth physical framebuffer width
 * @param {number} initialHeight physical framebuffer height
 * @param {{ mode?: "dirty" | "full" }} options
 */
export function createCanvasPresenter(initialContext, initialWidth, initialHeight, options = {}) {
  const mode = options.mode ?? "dirty";
  if (mode !== "dirty" && mode !== "full") throw new RangeError(`unknown canvas upload mode ${mode}`);

  let context;
  let width;
  let height;
  let image;
  let needsFullUpload = true;

  /** Canvas resize and context restoration both discard every presented pixel. */
  function reset(nextContext, nextWidth, nextHeight) {
    if (!nextContext || typeof nextContext.createImageData !== "function") {
      throw new TypeError("canvas presenter requires a 2d context");
    }
    context = nextContext;
    width = dimension(nextWidth, "framebuffer width");
    height = dimension(nextHeight, "framebuffer height");
    image = context.createImageData(width, height);
    needsFullUpload = true;
  }

  function fullUpload(pixels) {
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    needsFullUpload = false;
    return -1;
  }

  reset(initialContext, initialWidth, initialHeight);

  return {
    /** Force the next present to restore the complete canvas. */
    invalidate() {
      needsFullUpload = true;
    },

    reset,

    /**
     * Present one retained framebuffer. Returns -1 for a full upload, zero for
     * no upload, or the number of dirty rectangles uploaded. `damage` is the
     * reused object returned by wasm-ops damageRects().
     */
    present(pixels, damage) {
      if (!pixels || pixels.byteLength !== image.data.byteLength) {
        throw new RangeError(
          `framebuffer has ${pixels?.byteLength ?? 0} bytes; expected ${image.data.byteLength}`,
        );
      }
      if (mode === "full" || needsFullUpload || !damage || !damage.rects) {
        return fullUpload(pixels);
      }

      const count = damage.count;
      const scale = damage.scale;
      if (!Number.isInteger(count) || count < 0 || count * 4 > damage.rects.length ||
          !Number.isInteger(scale) || scale <= 0) {
        return fullUpload(pixels);
      }
      if (count === 0) return 0;

      // A policy-promoted redraw is represented by one whole-surface region.
      // Use the three-argument overload so browsers take their full upload path.
      for (let index = 0; index < count; index++) {
        const at = index * 4;
        if (damage.rects[at] * scale <= 0 && damage.rects[at + 1] * scale <= 0 &&
            damage.rects[at + 2] * scale >= width && damage.rects[at + 3] * scale >= height) {
          return fullUpload(pixels);
        }
      }

      let uploads = 0;
      for (let index = 0; index < count; index++) {
        const at = index * 4;
        const x0 = Math.max(0, Math.min(width, damage.rects[at] * scale));
        const y0 = Math.max(0, Math.min(height, damage.rects[at + 1] * scale));
        const x1 = Math.max(0, Math.min(width, damage.rects[at + 2] * scale));
        const y1 = Math.max(0, Math.min(height, damage.rects[at + 3] * scale));
        if (x0 >= x1 || y0 >= y1) continue;

        const rowBytes = (x1 - x0) * 4;
        for (let y = y0; y < y1; y++) {
          const offset = (y * width + x0) * 4;
          image.data.set(pixels.subarray(offset, offset + rowBytes), offset);
        }
        context.putImageData(image, 0, 0, x0, y0, x1 - x0, y1 - y0);
        uploads++;
      }
      needsFullUpload = false;
      return uploads;
    },
  };
}
