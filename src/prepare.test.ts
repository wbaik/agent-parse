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

async function imageBuffer() {
  return sharp({
    create: {
      width: 64,
      height: 48,
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
