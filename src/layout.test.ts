import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { segmentPageLayout, type OcrItem } from "./layout.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-layout-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function whitePng(width: number, height: number): Promise<string> {
  const file = path.join(dir, `white_${width}x${height}.png`);
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toFile(file);
  return file;
}

async function blackRect(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function pngWithBlackRects(
  width: number,
  height: number,
  rects: Array<{ left: number; top: number; w: number; h: number }>,
  filename = "ink.png",
): Promise<string> {
  const file = path.join(dir, filename);
  const composite = await Promise.all(
    rects.map(async (r) => ({
      input: await blackRect(r.w, r.h),
      top: r.top,
      left: r.left,
    })),
  );
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite(composite)
    .png()
    .toFile(file);
  return file;
}

describe("segmentPageLayout", () => {
  it("returns no regions when there are no OCR items", async () => {
    const imagePath = await whitePng(100, 100);
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: [],
    });
    expect(regions).toEqual([]);
  });

  it("emits one bbox=null region when OCR items lack geometry", async () => {
    const imagePath = await whitePng(100, 100);
    const items: OcrItem[] = [
      { text: "FOO", fontName: "OCR", confidence: 0.95 },
      { text: "BAR", fontName: "OCR", confidence: 0.4 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox).toBeNull();
    expect(regions[0]?.hasLowConfidence).toBe(true);
  });

  it("emits one bbox=null region when pageDimensions are missing", async () => {
    const imagePath = await whitePng(100, 100);
    const items: OcrItem[] = [
      { text: "X", fontName: "OCR", confidence: 0.9, x: 10, y: 10, width: 20, height: 10 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: null,
      ocrItems: items,
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox).toBeNull();
    expect(regions[0]?.hasLowConfidence).toBe(false);
  });

  it("falls back to OCR-bbox clustering when the page image has no ink", async () => {
    // 200x200 px page representing 100x100 pt → scale 2 px/pt.
    const imagePath = await whitePng(200, 200);
    const items: OcrItem[] = [
      { text: "INPUT", fontName: "OCR", confidence: 0.95, x: 10, y: 50, width: 15, height: 6 },
      { text: "LLM", fontName: "OCR", confidence: 0.92, x: 30, y: 50, width: 10, height: 6 },
      { text: "OUT", fontName: "OCR", confidence: 0.94, x: 45, y: 50, width: 12, height: 6 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox).toEqual({
      x: 10,
      y: 50,
      width: 47,
      height: 6,
    });
    expect(regions[0]?.hasLowConfidence).toBe(false);
  });

  it("emits one region per ink component when OCR items map to distinct ink blobs", async () => {
    // 200x200 px page representing 100x100 pt → scale 2 px/pt.
    // Two distinct black rectangles separated by a wide gap.
    const imagePath = await pngWithBlackRects(200, 200, [
      { left: 20, top: 20, w: 40, h: 40 }, // pt: x=10..30, y=10..30
      { left: 130, top: 130, w: 40, h: 40 }, // pt: x=65..85, y=65..85
    ]);
    const items: OcrItem[] = [
      // Centroid (20pt, 20pt) → in first blob
      { text: "FIG1", fontName: "OCR", confidence: 0.95, x: 18, y: 18, width: 4, height: 4 },
      // Centroid (75pt, 75pt) → in second blob
      { text: "FIG2", fontName: "OCR", confidence: 0.4, x: 73, y: 73, width: 4, height: 4 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
      // Small dilation so blobs stay separate.
      dilationKernelPx: 3,
    });

    expect(regions).toHaveLength(2);
    // Sort by bbox.x for deterministic order.
    const sorted = [...regions].sort((a, b) => (a.bbox?.x ?? 0) - (b.bbox?.x ?? 0));
    expect(sorted[0]?.bbox?.x).toBeLessThan(50);
    expect(sorted[0]?.hasLowConfidence).toBe(false);
    expect(sorted[1]?.bbox?.x).toBeGreaterThan(50);
    expect(sorted[1]?.hasLowConfidence).toBe(true);
  });

  it("merges adjacent ink into a single component when dilation kernel is large", async () => {
    // Two near rectangles that should merge after generous dilation.
    const imagePath = await pngWithBlackRects(200, 200, [
      { left: 20, top: 20, w: 40, h: 40 },
      { left: 70, top: 20, w: 40, h: 40 }, // 10px horizontal gap between rects
    ]);
    const items: OcrItem[] = [
      { text: "L", fontName: "OCR", confidence: 0.9, x: 18, y: 18, width: 4, height: 4 },
      { text: "R", fontName: "OCR", confidence: 0.9, x: 45, y: 18, width: 4, height: 4 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
      dilationKernelPx: 21,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox?.width).toBeGreaterThan(40);
  });

  it("drops ink components below minComponentAreaPx", async () => {
    // One large blob and one tiny noise dot. OCR item only on the big blob.
    const imagePath = await pngWithBlackRects(200, 200, [
      { left: 20, top: 20, w: 40, h: 40 },
      { left: 180, top: 180, w: 2, h: 2 },
    ]);
    const items: OcrItem[] = [
      { text: "BIG", fontName: "OCR", confidence: 0.95, x: 18, y: 18, width: 4, height: 4 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
      dilationKernelPx: 3,
      minComponentAreaPx: 100,
    });

    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox?.x).toBeLessThan(50);
  });

  it("falls back to OCR-bbox cluster when the only component covers most of the page", async () => {
    // Whole page is solid black (cover-page-style dark background). The only
    // component would span the entire page → too coarse for visual review.
    const imagePath = await pngWithBlackRects(200, 200, [
      { left: 0, top: 0, w: 200, h: 200 },
    ]);
    const items: OcrItem[] = [
      { text: "TITLE", fontName: "OCR", confidence: 0.95, x: 30, y: 50, width: 40, height: 10 },
      { text: "SUB", fontName: "OCR", confidence: 0.9, x: 30, y: 70, width: 25, height: 10 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
      dilationKernelPx: 3,
    });
    expect(regions).toHaveLength(1);
    // Bbox is the OCR cluster, not the full page.
    expect(regions[0]?.bbox?.x).toBe(30);
    expect(regions[0]?.bbox?.width).toBeLessThan(80);
  });

  it("clusters orphan OCR items (none over ink) using OCR-bbox fallback", async () => {
    // One ink blob and OCR items elsewhere on the page (over white).
    const imagePath = await pngWithBlackRects(200, 200, [
      { left: 20, top: 20, w: 40, h: 40 }, // pt: x=10..30, y=10..30
    ]);
    const items: OcrItem[] = [
      // Orphan items on right half of page (no ink there)
      { text: "A", fontName: "OCR", confidence: 0.95, x: 60, y: 80, width: 5, height: 5 },
      { text: "B", fontName: "OCR", confidence: 0.95, x: 70, y: 80, width: 5, height: 5 },
    ];
    const regions = await segmentPageLayout({
      imagePath,
      pageDimensions: { widthPoints: 100, heightPoints: 100 },
      ocrItems: items,
      dilationKernelPx: 3,
    });

    // One cluster of orphans (no items mapped to the ink blob).
    expect(regions).toHaveLength(1);
    expect(regions[0]?.bbox?.x).toBe(60);
  });
});
