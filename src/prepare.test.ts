import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepare } from "./prepare.js";
import type { LiteParseAdapter } from "./prepare.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-prepare-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePdfFixture() {
  const file = path.join(dir, "input.pdf");
  await writeFile(file, "not really a pdf for mocked tests");
  return file;
}

async function imageBuffer(width = 64, height = 48) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function fakeAdapter(parseJson: unknown): LiteParseAdapter {
  return {
    async parse() {
      return parseJson;
    },
    async screenshot(_input, pages) {
      const buffer = await imageBuffer();
      return pages.map((pageNum) => ({ pageNum, imageBuffer: buffer }));
    },
  };
}

describe("prepare", () => {
  it("rejects a missing input before creating output", async () => {
    const outputDir = path.join(dir, "out");

    await expect(
      prepare({
        input: path.join(dir, "missing.pdf"),
        outputDir,
        adapter: fakeAdapter({ pages: [] }),
      }),
    ).rejects.toThrow(/input file not found/i);

    await expect(stat(outputDir)).rejects.toThrow();
  });

  it("rejects an existing non-empty output directory without force", async () => {
    const input = await writePdfFixture();
    const outputDir = path.join(dir, "out");
    await mkdir(outputDir);
    await writeFile(path.join(outputDir, "keep.txt"), "existing");

    await expect(
      prepare({ input, outputDir, adapter: fakeAdapter({ pages: [] }) }),
    ).rejects.toThrow(/output directory is not empty/i);
  });

  it("writes parse artifacts and full-page shots for flagged pages", async () => {
    const input = await writePdfFixture();
    const outputDir = path.join(dir, "out");

    await prepare({
      input,
      outputDir,
      force: true,
      adapter: fakeAdapter({
        pages: [
          {
            page: 2,
            text: "Figure 2: Something",
            textItems: [
              { text: "FINANCE", fontName: "OCR", confidence: 0.4 },
              { text: "AGENT", fontName: "OCR", confidence: 0.5 },
            ],
          },
        ],
      }),
    });

    const parseJson = JSON.parse(
      await readFile(path.join(outputDir, "parse.json"), "utf8"),
    );
    const regions = JSON.parse(
      await readFile(path.join(outputDir, "suspicious-regions.json"), "utf8"),
    );
    const tasks = JSON.parse(
      await readFile(path.join(outputDir, "visual-review-tasks.json"), "utf8"),
    );

    expect(parseJson.pages).toHaveLength(1);
    expect(regions).toHaveLength(1);
    expect(regions[0].bbox).toBeNull();
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0].crop).toBe("shots/page_2.png");
    await expect(
      stat(path.join(outputDir, "shots", "page_2.png")),
    ).resolves.toBeTruthy();
  });

  it("crops per-region when OCR items carry geometry and page dimensions are known", async () => {
    const input = await writePdfFixture();
    const outputDir = path.join(dir, "out");
    // Stub a 1224x1584 px screenshot for a 612x792 pt page (2 px/pt scale).
    const adapter: LiteParseAdapter = {
      async parse() {
        return {
          pages: [
            {
              page: 4,
              width: 612,
              height: 792,
              text: "Figure 4: harness",
              textItems: [
                { text: "INPUT", fontName: "OCR", confidence: 0.95, x: 100, y: 200, width: 60, height: 12 },
                { text: "LLM", fontName: "OCR", confidence: 0.93, x: 200, y: 200, width: 40, height: 12 },
                { text: "OUTPUT", fontName: "OCR", confidence: 0.94, x: 280, y: 200, width: 70, height: 12 },
              ],
            },
          ],
        };
      },
      async screenshot(_input, pages) {
        const buffer = await imageBuffer(1224, 1584);
        return pages.map((pageNum) => ({ pageNum, imageBuffer: buffer }));
      },
    };

    await prepare({ input, outputDir, force: true, adapter });

    const regions = JSON.parse(
      await readFile(path.join(outputDir, "suspicious-regions.json"), "utf8"),
    );
    const tasks = JSON.parse(
      await readFile(path.join(outputDir, "visual-review-tasks.json"), "utf8"),
    );

    expect(regions).toHaveLength(1);
    expect(regions[0].bbox).toEqual({
      x: 100,
      y: 200,
      width: 250,
      height: 12,
    });
    expect(regions[0].crop).toBe("shots/page_4_region_1.png");
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0].crop).toBe("shots/page_4_region_1.png");

    // Verify a real cropped file exists with bbox*scale + 2*padding dimensions.
    // bbox px: 200..700 wide, 400..424 tall. Padded ±24 → 176..724 wide, 376..448 tall.
    // → 548 × 72.
    const cropMeta = await sharp(
      path.join(outputDir, "shots", "page_4_region_1.png"),
    ).metadata();
    expect(cropMeta.width).toBe(548);
    expect(cropMeta.height).toBe(72);
    // Full-page shot still present alongside the crop.
    await expect(
      stat(path.join(outputDir, "shots", "page_4.png")),
    ).resolves.toBeTruthy();
  });

  it("writes an empty task list when no pages are flagged", async () => {
    const input = await writePdfFixture();
    const outputDir = path.join(dir, "out");

    await prepare({
      input,
      outputDir,
      force: true,
      adapter: fakeAdapter({
        pages: [{ page: 1, text: "Clean text", textItems: [] }],
      }),
    });

    const tasks = JSON.parse(
      await readFile(path.join(outputDir, "visual-review-tasks.json"), "utf8"),
    );
    expect(tasks.tasks).toEqual([]);
  });
});
