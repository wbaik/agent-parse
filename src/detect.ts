import type { BBox, SuspiciousRegion } from "./schemas.js";

export interface DetectionOptions {
  ocrConfidenceThreshold?: number;
}

interface UnknownPage {
  page?: unknown;
  pageNum?: unknown;
  text?: unknown;
  textItems?: unknown;
}

interface UnknownTextItem {
  text?: unknown;
  fontName?: unknown;
  confidence?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

interface GeoOcrItem {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number | undefined;
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

    const ocrItems = getTextItems(page).filter(isOcrItem);
    if (ocrItems.length === 0) {
      continue;
    }

    let regionIndex = 0;
    const nextRegionId = () => {
      regionIndex += 1;
      return `page_${pageNumber}_region_${regionIndex}`;
    };

    const geoItems = ocrItems
      .map(toGeoOcrItem)
      .filter((item): item is GeoOcrItem => item !== null);

    if (geoItems.length === 0) {
      const hasLowConfidence = ocrItems.some((item) => {
        const confidence = getNumber(item.confidence);
        return confidence !== undefined && confidence < threshold;
      });
      regions.push({
        page: pageNumber,
        region_id: nextRegionId(),
        kind: "unknown",
        reasons: buildReasons(hasLowConfidence),
        bbox: null,
      });
      continue;
    }

    for (const cluster of clusterOcrItems(geoItems)) {
      const bbox = unionBBox(cluster);
      if (!bbox) continue;
      const clusterHasLowConfidence = cluster.some(
        (item) =>
          item.confidence !== undefined && item.confidence < threshold,
      );
      regions.push({
        page: pageNumber,
        region_id: nextRegionId(),
        kind: "unknown",
        reasons: buildReasons(clusterHasLowConfidence),
        bbox,
      });
    }
  }

  return regions;
}

function buildReasons(hasLowConfidence: boolean): string[] {
  const reasons: string[] = ["ocr_text"];
  if (hasLowConfidence) {
    reasons.push("low_ocr_confidence");
  }
  return reasons;
}

function clusterOcrItems(items: GeoOcrItem[]): GeoOcrItem[][] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const heights = sorted
    .map((item) => item.height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianHeight =
    heights.length === 0 ? 12 : heights[Math.floor(heights.length / 2)]!;
  const verticalGapThreshold = medianHeight * 2;

  const clusters: GeoOcrItem[][] = [];
  for (const item of sorted) {
    const lastCluster = clusters[clusters.length - 1];
    if (!lastCluster) {
      clusters.push([item]);
      continue;
    }
    let lastBottom = -Infinity;
    for (const member of lastCluster) {
      const bottom = member.y + member.height;
      if (bottom > lastBottom) {
        lastBottom = bottom;
      }
    }
    const gap = item.y - lastBottom;
    if (gap <= verticalGapThreshold) {
      lastCluster.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters;
}

function unionBBox(cluster: GeoOcrItem[]): BBox | null {
  if (cluster.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of cluster) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x + item.width > maxX) maxX = item.x + item.width;
    if (item.y + item.height > maxY) maxY = item.y + item.height;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    x: Math.max(0, minX),
    y: Math.max(0, minY),
    width,
    height,
  };
}

function toGeoOcrItem(item: UnknownTextItem): GeoOcrItem | null {
  const x = getNumber(item.x);
  const y = getNumber(item.y);
  const width = getNumber(item.width);
  const height = getNumber(item.height);
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
  ) {
    return null;
  }
  if (width <= 0 || height <= 0 || x < 0 || y < 0) {
    return null;
  }
  return {
    x,
    y,
    width,
    height,
    confidence: getNumber(item.confidence),
  };
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
