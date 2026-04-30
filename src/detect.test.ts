import { describe, expect, it } from "vitest";
import { findPagesNeedingReview } from "./detect.js";

function parseWithPages(pages: unknown[]) {
  return { pages };
}

describe("findPagesNeedingReview", () => {
  it("returns no candidates for a clean page", () => {
    const candidates = findPagesNeedingReview(
      parseWithPages([
        {
          page: 1,
          textItems: [{ text: "Plain text", confidence: 1 }],
        },
      ]),
    );
    expect(candidates).toEqual([]);
  });

  it("returns one candidate per page with OCR items", () => {
    const candidates = findPagesNeedingReview(
      parseWithPages([
        {
          page: 1,
          textItems: [{ text: "Plain", confidence: 1 }],
        },
        {
          page: 2,
          width: 612,
          height: 792,
          textItems: [
            { text: "FINANCE", fontName: "OCR", confidence: 0.95 },
            { text: "AGENT", fontName: "OCR", confidence: 0.93 },
          ],
        },
        {
          page: 3,
          textItems: [{ text: "More plain text", confidence: 1 }],
        },
      ]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.page).toBe(2);
    expect(candidates[0]?.pageDimensions).toEqual({
      widthPoints: 612,
      heightPoints: 792,
    });
    expect(candidates[0]?.ocrItems).toHaveLength(2);
  });

  it("returns null pageDimensions when width/height are missing", () => {
    const candidates = findPagesNeedingReview(
      parseWithPages([
        {
          page: 4,
          textItems: [{ text: "X", fontName: "OCR", confidence: 0.9 }],
        },
      ]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.pageDimensions).toBeNull();
  });

  it("ignores non-OCR items but keeps the page if at least one OCR item exists", () => {
    const candidates = findPagesNeedingReview(
      parseWithPages([
        {
          page: 5,
          width: 612,
          height: 792,
          textItems: [
            { text: "regular", confidence: 1 },
            { text: "FOO", fontName: "OCR", confidence: 0.9 },
          ],
        },
      ]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ocrItems).toHaveLength(1);
    expect(candidates[0]?.ocrItems[0]?.fontName).toBe("OCR");
  });

  it("ignores malformed pages instead of throwing", () => {
    const candidates = findPagesNeedingReview({
      pages: [null, { text: 123 }, { page: 0, textItems: [] }],
    });
    expect(candidates).toEqual([]);
  });
});
