import type { PageDimensions } from "./images.js";
import type { OcrItem } from "./layout.js";

export interface PageCandidate {
  page: number;
  pageDimensions: PageDimensions | null;
  ocrItems: OcrItem[];
}

interface UnknownPage {
  page?: unknown;
  pageNum?: unknown;
  width?: unknown;
  height?: unknown;
  textItems?: unknown;
}

// Identify pages whose textItems contain any OCR-derived content. OCR presence
// is the only "this page may need visual review" signal we trust today; LLM
// drift on figures, tables, and charts triggers OCR fallback inside LiteParse,
// so the items with fontName === "OCR" are the load-bearing flag.
export function findPagesNeedingReview(parseJson: unknown): PageCandidate[] {
  const pages = getPages(parseJson);
  const candidates: PageCandidate[] = [];
  for (const page of pages) {
    const pageNumber =
      getPositiveInteger(page.page) ?? getPositiveInteger(page.pageNum);
    if (pageNumber === undefined) continue;

    const items = getOcrItems(page);
    if (items.length === 0) continue;

    candidates.push({
      page: pageNumber,
      pageDimensions: getPageDimensions(page),
      ocrItems: items,
    });
  }
  return candidates;
}

function getPages(parseJson: unknown): UnknownPage[] {
  if (!parseJson || typeof parseJson !== "object") return [];
  const pages = (parseJson as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) return [];
  return pages.filter(
    (p): p is UnknownPage => Boolean(p) && typeof p === "object",
  );
}

function getOcrItems(page: UnknownPage): OcrItem[] {
  if (!Array.isArray(page.textItems)) return [];
  const items: OcrItem[] = [];
  for (const raw of page.textItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as OcrItem;
    if (item.fontName === "OCR") items.push(item);
  }
  return items;
}

function getPageDimensions(page: UnknownPage): PageDimensions | null {
  const w = getPositiveNumber(page.width);
  const h = getPositiveNumber(page.height);
  if (w === undefined || h === undefined) return null;
  return { widthPoints: w, heightPoints: h };
}

function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
