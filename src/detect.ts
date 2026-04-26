import type { RegionKind, SuspiciousRegion } from "./schemas.js";

export interface DetectionOptions {
  ocrConfidenceThreshold?: number;
}

interface UnknownPage {
  page?: unknown;
  pageNum?: unknown;
  text?: unknown;
  textItems?: unknown;
  images?: unknown;
}

interface UnknownTextItem {
  text?: unknown;
  fontName?: unknown;
  confidence?: unknown;
}

const DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.8;

export function detectSuspiciousRegions(
  parseJson: unknown,
  options: DetectionOptions = {},
): SuspiciousRegion[] {
  const pages = getPages(parseJson);
  const threshold =
    options.ocrConfidenceThreshold ?? DEFAULT_OCR_CONFIDENCE_THRESHOLD;
  const regions: SuspiciousRegion[] = [];

  for (const page of pages) {
    const pageNumber =
      getPositiveInteger(page.page) ?? getPositiveInteger(page.pageNum);
    if (!pageNumber) {
      continue;
    }

    const items = getTextItems(page);
    const ocrItems = items.filter(isOcrItem);
    const pageHasEmbeddedImages =
      Array.isArray(page.images) && page.images.length > 0;

    if (ocrItems.length === 0 && !pageHasEmbeddedImages) {
      continue;
    }

    const reasons = new Set<string>();
    if (ocrItems.length > 0) {
      reasons.add("ocr_text");
    }
    if (
      ocrItems.some((item) => {
        const confidence = getNumber(item.confidence);
        return confidence !== undefined && confidence < threshold;
      })
    ) {
      reasons.add("low_ocr_confidence");
    }
    if (
      ocrItems.length > 0 &&
      typeof page.text === "string" &&
      /\bFigure\s+\d+\s*:/i.test(page.text)
    ) {
      reasons.add("figure_caption");
    }
    if (pageHasEmbeddedImages) {
      reasons.add("embedded_images");
    }

    regions.push({
      page: pageNumber,
      region_id: `page_${pageNumber}_region_1`,
      kind: inferKind(reasons),
      reasons: Array.from(reasons),
      bbox: null,
    });
  }

  return regions;
}

function getPages(parseJson: unknown): UnknownPage[] {
  if (!parseJson || typeof parseJson !== "object") {
    return [];
  }
  const pages = (parseJson as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) {
    return [];
  }
  return pages.filter(
    (page): page is UnknownPage => Boolean(page) && typeof page === "object",
  );
}

function getTextItems(page: UnknownPage): UnknownTextItem[] {
  if (!Array.isArray(page.textItems)) {
    return [];
  }
  return page.textItems.filter(
    (item): item is UnknownTextItem =>
      Boolean(item) && typeof item === "object",
  );
}

function isOcrItem(item: UnknownTextItem): boolean {
  return item.fontName === "OCR";
}

function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferKind(reasons: Set<string>): RegionKind {
  if (reasons.has("figure_caption") || reasons.has("embedded_images")) {
    return "figure";
  }
  if (reasons.has("ocr_text") || reasons.has("low_ocr_confidence")) {
    return "ocr";
  }
  return "page";
}
