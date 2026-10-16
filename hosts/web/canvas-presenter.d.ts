export interface CanvasDamage {
  readonly rects: Int32Array;
  readonly count: number;
  readonly scale: number;
}

export interface CanvasPresenter {
  invalidate(): void;
  reset(context: CanvasRenderingContext2D, width: number, height: number): void;
  /** -1 for full upload, 0 for no upload, otherwise dirty upload count. */
  present(pixels: Uint8Array, damage: CanvasDamage | null): number;
}

export declare function createCanvasPresenter(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options?: { mode?: "dirty" | "full" },
): CanvasPresenter;
