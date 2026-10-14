import type { HostOps } from "../../framework/src/host.ts";

export declare const FONT_MAGIC: number;
export declare const FONT_HEADER_SIZE: number;
export declare const FONT_CMAP_ENTRY_SIZE: number;
export declare const DEFAULT_FALLBACK_FAMILIES: string;
export declare const MAX_GLYPHS: number;
export declare const BITMAP_CUT: number;

export type RuntimeGlyphEntry = [
  codepoint: number,
  glyphId: number,
  advance: number,
  xOffset: number,
];

export interface RuntimeGlyphAtlas {
  cellW: number;
  cellH: number;
  baseline: number;
  lineHeight: number;
  slot: number;
  flags: number;
  density: number;
  glyphs: RuntimeGlyphEntry[];
  known: Set<number>;
  coverage: Uint8Array;
  em: number;
  bilevel: boolean;
}

export interface RasterizedGlyph {
  advance: number;
  width: number;
  coverage: Uint8Array;
}

export type RuntimeGlyphRasterizer = (
  codepoint: number,
  atlas: RuntimeGlyphAtlas,
) => RasterizedGlyph | null;

export declare function parseAtlas(
  bytes: ArrayBuffer | Uint8Array,
): RuntimeGlyphAtlas | null;
export declare function widenAtlas(
  atlas: RuntimeGlyphAtlas,
  cellWidth: number,
): void;
export declare function appendGlyph(
  atlas: RuntimeGlyphAtlas,
  codepoint: number,
  glyph: RasterizedGlyph,
): boolean;
export declare function serializeAtlas(atlas: RuntimeGlyphAtlas): Uint8Array;
export declare function canvasRasterizer(options?: {
  families?: string;
  createCanvas?: (width: number, height: number) => unknown;
}): RuntimeGlyphRasterizer;

export interface RuntimeGlyphInstallation {
  ensure(text: string): void;
  flush(): void;
  stats(): {
    glyphs: number;
    cells: number;
    reloads: number;
    ms: number;
    full: number;
    slots: number;
  };
}

export declare function installRuntimeGlyphs(
  ops: HostOps,
  options?: {
    rasterize?: RuntimeGlyphRasterizer;
    now?: () => number;
  },
): RuntimeGlyphInstallation;
