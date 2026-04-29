import { describe, expect, it } from "vitest";
import { detectSuspiciousRegions } from "./detect.js";

function parseWithPages(pages: unknown[]) {
  return { pages };
}

describe("detectSuspiciousRegions", () => {
  it("returns no regions for a clean page", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 1,
          text: "A normal page of text.",
          textItems: [{ text: "A normal page of text.", confidence: 1 }],
        },
      ]),
    );

    expect(regions).toEqual([]);
  });

  it("flags pages with OCR text", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 2,
          text: "Figure 2: Architecture",
          textItems: [
            { text: "FINANCE", fontName: "OCR", confidence: 0.95 },
            { text: "AGENT", fontName: "OCR", confidence: 0.93 },
            { text: "|", fontName: "OCR", confidence: 0.4 },
          ],
        },
      ]),
    );

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      page: 2,
      region_id: "page_2_region_1",
      kind: "unknown",
      bbox: null,
    });
    expect(regions[0]?.reasons).toEqual(
      expect.arrayContaining(["ocr_text", "low_ocr_confidence"]),
    );
  });

  it("does not flag a page with only normal text", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 4,
          text: "Figure 2: Architecture of the Finance Agent Benchmark.",
          textItems: [{ text: "Figure 2: Architecture", confidence: 0.99 }],
        },
      ]),
    );

    expect(regions).toEqual([]);
  });

  it("does not flag a page that has only embedded images (no OCR signal)", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 5,
          text: "Some surrounding prose.",
          textItems: [],
          images: [{ id: "img1" }],
        },
      ]),
    );

    expect(regions).toEqual([]);
  });

  it("flags only the pages where OCR is detected", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 1,
          text: "Plain text",
          textItems: [{ text: "Plain text", confidence: 1 }],
        },
        {
          page: 2,
          text: "Figure 1: foo",
          textItems: [{ text: "FOO", fontName: "OCR", confidence: 0.9 }],
        },
        {
          page: 3,
          text: "More plain text",
          textItems: [{ text: "More plain text", confidence: 1 }],
        },
      ]),
    );

    expect(regions).toHaveLength(1);
    expect(regions[0]?.page).toBe(2);
  });

  it("ignores malformed pages instead of throwing", () => {
    const regions = detectSuspiciousRegions({ pages: [null, { text: 123 }] });

    expect(regions).toEqual([]);
  });

  it("produces a single bbox region when OCR items cluster together", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 7,
          width: 612,
          height: 792,
          text: "Figure 3: pipeline overview",
          textItems: [
            { text: "INPUT", fontName: "OCR", confidence: 0.95, x: 100, y: 200, width: 60, height: 12 },
            { text: "LLM", fontName: "OCR", confidence: 0.92, x: 200, y: 200, width: 40, height: 12 },
            { text: "OUTPUT", fontName: "OCR", confidence: 0.94, x: 280, y: 200, width: 70, height: 12 },
          ],
        },
      ]),
    );

    expect(regions).toHaveLength(1);
    const region = regions[0]!;
    expect(region.kind).toBe("unknown");
    expect(region.bbox).toEqual({
      x: 100,
      y: 200,
      width: 250,
      height: 12,
    });
    expect(region.region_id).toBe("page_7_region_1");
  });

  it("splits OCR items into multiple regions when they are vertically far apart", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 8,
          width: 612,
          height: 792,
          text: "scattered ocr",
          textItems: [
            { text: "TOP", fontName: "OCR", confidence: 0.95, x: 100, y: 100, width: 50, height: 12 },
            { text: "ALSO_TOP", fontName: "OCR", confidence: 0.95, x: 200, y: 102, width: 80, height: 12 },
            { text: "BOTTOM", fontName: "OCR", confidence: 0.95, x: 100, y: 600, width: 60, height: 12 },
          ],
        },
      ]),
    );

    expect(regions).toHaveLength(2);
    expect(regions[0]?.region_id).toBe("page_8_region_1");
    expect(regions[1]?.region_id).toBe("page_8_region_2");
    expect(regions[0]?.bbox?.y).toBe(100);
    expect(regions[1]?.bbox?.y).toBe(600);
  });

  it("produces one region for a tightly grouped multi-row OCR cluster", () => {
    const regions = detectSuspiciousRegions(
      parseWithPages([
        {
          page: 9,
          width: 612,
          height: 792,
          text: "Table 2: results breakdown",
          textItems: [
            { text: "model", fontName: "OCR", confidence: 0.95, x: 100, y: 200, width: 40, height: 10 },
            { text: "score", fontName: "OCR", confidence: 0.95, x: 200, y: 200, width: 40, height: 10 },
            { text: "A", fontName: "OCR", confidence: 0.95, x: 100, y: 215, width: 40, height: 10 },
            { text: "0.91", fontName: "OCR", confidence: 0.95, x: 200, y: 215, width: 40, height: 10 },
            { text: "B", fontName: "OCR", confidence: 0.95, x: 100, y: 230, width: 40, height: 10 },
            { text: "0.87", fontName: "OCR", confidence: 0.95, x: 200, y: 230, width: 40, height: 10 },
          ],
        },
      ]),
    );

    expect(regions).toHaveLength(1);
    expect(regions[0]?.kind).toBe("unknown");
    expect(regions[0]?.reasons).toEqual(["ocr_text"]);
  });
});
