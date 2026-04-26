import { describe, expect, it } from "vitest";
import {
  CorrectionsArtifactSchema,
  CorrectionsArtifactJsonSchema,
  HybridArtifactSchema,
  SuspiciousRegionSchema,
  VisualReviewTaskSchema,
} from "./schemas.js";

describe("artifact schemas", () => {
  it("accepts a valid corrections artifact", () => {
    const parsed = CorrectionsArtifactSchema.parse({
      source_pdf: "document.pdf",
      corrections: [
        {
          page: 2,
          region_id: "page_2_region_1",
          crop: "crops/page_2_region_1.png",
          kind: "figure",
          corrected_extraction: { title: "Figure title" },
          notes: "Visible labels corrected from crop.",
        },
      ],
    });

    expect(parsed.corrections[0]?.region_id).toBe("page_2_region_1");
  });

  it("rejects corrections missing the corrections array", () => {
    expect(() =>
      CorrectionsArtifactSchema.parse({ source_pdf: "document.pdf" }),
    ).toThrow();
  });

  it("exports a strict corrections JSON schema compatible with model structured output", () => {
    const correction = CorrectionsArtifactJsonSchema.properties.corrections.items;
    expect(correction.additionalProperties).toBe(false);
    expect(correction.required).toEqual([
      "page",
      "region_id",
      "crop",
      "kind",
      "corrected_extraction",
      "notes",
    ]);
    expect(
      correction.properties.corrected_extraction.additionalProperties,
    ).toBe(false);
  });

  it("rejects a correction with an invalid page number", () => {
    expect(() =>
      CorrectionsArtifactSchema.parse({
        source_pdf: "document.pdf",
        corrections: [
          {
            page: 0,
            region_id: "page_0_region_1",
            crop: "crops/page_0_region_1.png",
            kind: "figure",
            corrected_extraction: {},
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a correction missing region_id", () => {
    expect(() =>
      CorrectionsArtifactSchema.parse({
        source_pdf: "document.pdf",
        corrections: [
          {
            page: 1,
            crop: "crops/page_1_region_1.png",
            kind: "figure",
            corrected_extraction: {},
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts suspicious regions and visual review tasks", () => {
    const region = SuspiciousRegionSchema.parse({
      page: 5,
      region_id: "page_5_region_1",
      kind: "figure",
      reasons: ["ocr_text", "low_ocr_confidence"],
      bbox: null,
      crop: "crops/page_5_region_1.png",
    });

    const task = VisualReviewTaskSchema.parse({
      region_id: region.region_id,
      page: region.page,
      kind: region.kind,
      crop: region.crop,
      reasons: region.reasons,
      prompt: "Extract the visible figure labels as JSON.",
    });

    expect(task.page).toBe(5);
  });

  it("accepts a hybrid artifact with visual corrections", () => {
    const hybrid = HybridArtifactSchema.parse({
      source: {
        parse: "parse.json",
        suspicious_regions: "suspicious-regions.json",
        corrections: "corrections.json",
      },
      parse: { pages: [] },
      suspicious_regions: [],
      visual_corrections: [
        {
          page: 2,
          region_id: "page_2_region_1",
          crop: "crops/page_2_region_1.png",
          kind: "figure",
          corrected_extraction: { labels: [] },
        },
      ],
    });

    expect(hybrid.visual_corrections).toHaveLength(1);
  });
});
