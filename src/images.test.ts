import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function createShot(name: string) {
  const file = path.join(dir, name);
  await sharp({
    create: {
      width: 100,
      height: 80,
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
});
