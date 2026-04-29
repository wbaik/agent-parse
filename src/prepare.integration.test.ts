import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepare } from "./prepare.js";
import {
  SuspiciousRegionSchema,
  VisualReviewTaskManifestSchema,
} from "./schemas.js";

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "test",
  "fixtures",
  "gatheral-volatility-surface.pdf",
);

let outputDir: string;

beforeAll(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), "agent-parse-integration-"));
  await prepare({
    input: FIXTURE,
    outputDir,
    force: true,
    dpi: 100,
  });
}, 120_000);

afterAll(async () => {
  if (outputDir) {
    await rm(outputDir, { recursive: true, force: true });
  }
});

describe("prepare against a real 210-page PDF", () => {
  it("writes the four expected top-level artifacts", async () => {
    for (const name of [
      "parse.json",
      "suspicious-regions.json",
      "visual-review-tasks.json",
      "corrections-schema.json",
    ]) {
      await expect(stat(path.join(outputDir, name))).resolves.toBeTruthy();
    }
  });

  it("produces schema-valid suspicious regions with real OCR-derived bboxes", async () => {
    const raw = JSON.parse(
      await readFile(path.join(outputDir, "suspicious-regions.json"), "utf8"),
    );
    const regions = raw.map((r: unknown) => SuspiciousRegionSchema.parse(r));

    expect(regions.length).toBeGreaterThan(0);
    // At least one region must come from a real OCR cluster with geometry,
    // not just the geometry-less fallback.
    const withBbox = regions.filter((r) => r.bbox !== null);
    expect(withBbox.length).toBeGreaterThan(0);

    for (const region of regions) {
      expect(region.region_id).toMatch(/^page_\d+_region_\d+$/);
      expect(region.reasons).toContain("ocr_text");
    }
  });

  it("emits a manifest whose every task references an existing PNG crop", async () => {
    const manifest = VisualReviewTaskManifestSchema.parse(
      JSON.parse(
        await readFile(
          path.join(outputDir, "visual-review-tasks.json"),
          "utf8",
        ),
      ),
    );

    expect(manifest.tasks.length).toBeGreaterThan(0);
    for (const task of manifest.tasks) {
      const cropPath = path.join(outputDir, task.crop);
      const meta = await sharp(cropPath).metadata();
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
    }
  });

  it("respects the per-page region_id sequence (1-indexed, contiguous per page)", async () => {
    const regions = JSON.parse(
      await readFile(path.join(outputDir, "suspicious-regions.json"), "utf8"),
    ) as Array<{ page: number; region_id: string }>;

    const byPage = new Map<number, string[]>();
    for (const r of regions) {
      const existing = byPage.get(r.page) ?? [];
      existing.push(r.region_id);
      byPage.set(r.page, existing);
    }
    for (const [page, ids] of byPage) {
      ids.forEach((id, i) => {
        expect(id).toBe(`page_${page}_region_${i + 1}`);
      });
    }
  });
});
