import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRegionCrops } from "./images.js";
import type { SuspiciousRegion } from "./schemas.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-images-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function createShot(name: string, width = 100, height = 80) {
  const file = path.join(dir, name);
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

describe("writeRegionCrops", () => {
  it("points each region at its page shot", async () => {
    await createShot("page_2.png");
    const regions: SuspiciousRegion[] = [
      {
        page: 2,
        region_id: "page_2_region_1",
        kind: "figure",
        reasons: ["ocr_text"],
        bbox: null,
      },
    ];

    const results = await writeRegionCrops({ regions, shotsDir: dir });

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    if (results[0]?.ok) {
      expect(results[0].crop).toBe("shots/page_2.png");
    }
    expect(await readFile(path.join(dir, "page_2.png"))).toBeTruthy();
  });

  it("records a per-region failure when the page shot is missing", async () => {
    const regions: SuspiciousRegion[] = [
      {
        page: 9,
        region_id: "page_9_region_1",
        kind: "figure",
        reasons: ["ocr_text"],
        bbox: null,
      },
    ];

    const results = await writeRegionCrops({ regions, shotsDir: dir });

    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toMatch(/missing/i);
    }
  });

  it("returns empty for empty input", async () => {
    const results = await writeRegionCrops({ regions: [], shotsDir: dir });
    expect(results).toEqual([]);
  });

  it("crops a region using bbox in PDF points and page dimensions", async () => {
    // 1000x800 px shot for a 500x400 pt page → 2 px/pt scale.
    await createShot("page_3.png", 1000, 800);
    const regions: SuspiciousRegion[] = [
      {
        page: 3,
        region_id: "page_3_region_1",
        kind: "table",
        reasons: ["ocr_text"],
        bbox: { x: 100, y: 200, width: 80, height: 50 },
      },
    ];

    const results = await writeRegionCrops({
      regions,
      shotsDir: dir,
      pageDimensions: new Map([[3, { widthPoints: 500, heightPoints: 400 }]]),
      paddingPx: 24,
    });

    expect(results[0]?.ok).toBe(true);
    if (!results[0]?.ok) return;
    expect(results[0].crop).toBe("shots/page_3_region_1.png");

    const cropPath = path.join(dir, "page_3_region_1.png");
    const cropMeta = await sharp(cropPath).metadata();
    // bbox in pixels: x=200, y=400, w=160, h=100
    // Padded by 24 → left=176, top=376, right=384, bottom=524
    // Floor/Ceil → 176, 376, 384, 524 → 208 x 148
    expect(cropMeta.width).toBe(208);
    expect(cropMeta.height).toBe(148);
    const cropStat = await stat(cropPath);
    expect(cropStat.size).toBeGreaterThan(0);
  });

  it("clamps padded crops to page bounds at edges", async () => {
    await createShot("page_4.png", 1000, 800);
    const regions: SuspiciousRegion[] = [
      {
        page: 4,
        region_id: "page_4_region_1",
        kind: "ocr",
        reasons: ["ocr_text"],
        bbox: { x: 0, y: 0, width: 10, height: 10 },
      },
    ];

    const results = await writeRegionCrops({
      regions,
      shotsDir: dir,
      pageDimensions: new Map([[4, { widthPoints: 500, heightPoints: 400 }]]),
      paddingPx: 24,
    });

    expect(results[0]?.ok).toBe(true);
    const cropPath = path.join(dir, "page_4_region_1.png");
    const meta = await sharp(cropPath).metadata();
    // bbox in px: 0,0,20,20. Padded -24 clamped to 0; right=44, bottom=44.
    expect(meta.width).toBe(44);
    expect(meta.height).toBe(44);
  });

  it("falls back to the full page shot when bbox is null", async () => {
    await createShot("page_6.png", 100, 80);
    const regions: SuspiciousRegion[] = [
      {
        page: 6,
        region_id: "page_6_region_1",
        kind: "figure",
        reasons: ["embedded_images"],
        bbox: null,
      },
    ];

    const results = await writeRegionCrops({
      regions,
      shotsDir: dir,
      pageDimensions: new Map([[6, { widthPoints: 500, heightPoints: 400 }]]),
    });

    expect(results[0]?.ok).toBe(true);
    if (!results[0]?.ok) return;
    expect(results[0].crop).toBe("shots/page_6.png");
  });

  it("records a per-region failure when page dimensions are missing for a bbox region", async () => {
    await createShot("page_8.png", 100, 80);
    const regions: SuspiciousRegion[] = [
      {
        page: 8,
        region_id: "page_8_region_1",
        kind: "ocr",
        reasons: ["ocr_text"],
        bbox: { x: 10, y: 10, width: 10, height: 10 },
      },
    ];

    const results = await writeRegionCrops({
      regions,
      shotsDir: dir,
      pageDimensions: new Map(),
    });

    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toMatch(/page dimensions/i);
    }
  });
});
