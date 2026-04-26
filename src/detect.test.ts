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

  it("emits one OCR region per page when OCR text is present", () => {
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
      kind: "figure",
      bbox: null,
    });
    expect(regions[0]?.reasons).toEqual(
      expect.arrayContaining([
        "ocr_text",
        "low_ocr_confidence",
        "figure_caption",
      ]),
    );
  });

  it("does not flag a page that only mentions a figure caption (no OCR or images)", () => {
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

  it("flags a page with embedded images even without OCR", () => {
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

    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      page: 5,
      region_id: "page_5_region_1",
      kind: "figure",
      bbox: null,
    });
    expect(regions[0]?.reasons).toContain("embedded_images");
  });

  it("emits one region per page across multiple flagged pages", () => {
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
          images: [{ id: "img1" }],
        },
      ]),
    );

    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.page)).toEqual([2, 3]);
  });

  it("ignores malformed pages instead of throwing", () => {
    const regions = detectSuspiciousRegions({ pages: [null, { text: 123 }] });

    expect(regions).toEqual([]);
  });
});
