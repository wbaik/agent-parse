import sharp from "sharp";
import type { PageDimensions } from "./images.js";
import type { BBox } from "./schemas.js";

export interface OcrItem {
  text?: unknown;
  fontName?: unknown;
  confidence?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface SegmentPageLayoutInput {
  imagePath: string;
  pageDimensions: PageDimensions | null;
  ocrItems: OcrItem[];
  ocrConfidenceThreshold?: number;
  inkThreshold?: number;
  minComponentAreaPx?: number;
  dilationKernelPx?: number;
}

export interface LayoutRegion {
  bbox: BBox | null;
  hasLowConfidence: boolean;
}

interface GeoOcrItem {
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
  confidence: number | undefined;
}

const DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_INK_THRESHOLD = 200; // luminance < threshold → ink
const DEFAULT_MIN_COMPONENT_AREA_PX = 64;
// Default kernel target in PDF points. Roughly the typical body-text x-height +
// generous slack; converted to pixels via scaleY so we adapt to render DPI
// without depending on per-page OCR statistics (which are unstable when the
// page has a few oversized OCR items skewing the median).
const DEFAULT_KERNEL_POINTS = 8;
const MIN_DILATION_KERNEL_PX = 3;
const MAX_DILATION_KERNEL_PX = 64;
// If a single component covers more than this fraction of the page, treat it
// as "the whole page is one ink blob" (e.g., dark cover, dense body column
// that swallowed the figure) and fall back to OCR-bbox clustering for the
// items inside it. The component bbox is too coarse to be useful for review.
const MAX_COMPONENT_AREA_FRACTION = 0.5;

export async function segmentPageLayout(
  input: SegmentPageLayoutInput,
): Promise<LayoutRegion[]> {
  if (input.ocrItems.length === 0) {
    return [];
  }

  const threshold =
    input.ocrConfidenceThreshold ?? DEFAULT_OCR_CONFIDENCE_THRESHOLD;
  const geoItems = input.ocrItems
    .map(toGeoOcrItem)
    .filter((item): item is GeoOcrItem => item !== null);

  // Geometry-less or no page dimensions → single bbox=null fallback.
  if (geoItems.length === 0 || !input.pageDimensions) {
    const hasLow = anyLowConfidence(input.ocrItems, threshold);
    return [{ bbox: null, hasLowConfidence: hasLow }];
  }

  const { data, info } = await sharp(input.imagePath)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const widthPx = info.width;
  const heightPx = info.height;
  if (!widthPx || !heightPx) {
    return [{ bbox: null, hasLowConfidence: anyLowConfidence(input.ocrItems, threshold) }];
  }

  const scaleX = widthPx / input.pageDimensions.widthPoints;
  const scaleY = heightPx / input.pageDimensions.heightPoints;
  if (
    !Number.isFinite(scaleX) ||
    !Number.isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0
  ) {
    return [{ bbox: null, hasLowConfidence: anyLowConfidence(input.ocrItems, threshold) }];
  }

  const inkThreshold = input.inkThreshold ?? DEFAULT_INK_THRESHOLD;
  const minArea = input.minComponentAreaPx ?? DEFAULT_MIN_COMPONENT_AREA_PX;
  const ink = buildInkMask(data, widthPx, heightPx, info.channels, inkThreshold);

  const kernel = resolveKernelSize(input.dilationKernelPx, scaleY);
  const dilated = kernel >= 1 ? dilateBox(ink, widthPx, heightPx, kernel) : ink;
  const components = findComponents(dilated, widthPx, heightPx, minArea);

  if (components.length === 0) {
    return clusterOrphans(geoItems, threshold);
  }

  const pageAreaPx = widthPx * heightPx;
  const maxComponentArea = pageAreaPx * MAX_COMPONENT_AREA_FRACTION;

  const itemsPerComponent = new Map<number, GeoOcrItem[]>();
  const orphans: GeoOcrItem[] = [];
  for (const item of geoItems) {
    const cxPx = (item.xPt + item.widthPt / 2) * scaleX;
    const cyPx = (item.yPt + item.heightPt / 2) * scaleY;
    const cIdx = locateComponent(components, cxPx, cyPx);
    if (cIdx === -1) {
      orphans.push(item);
      continue;
    }
    const comp = components[cIdx]!;
    const compArea = (comp.maxX - comp.minX + 1) * (comp.maxY - comp.minY + 1);
    if (compArea > maxComponentArea) {
      // Component is too coarse to be a useful review crop (e.g., the page's
      // entire body text merged with the figure, or a dark cover swallowed
      // everything). Treat the item as orphan so it gets a tighter OCR-bbox
      // cluster instead.
      orphans.push(item);
      continue;
    }
    const bucket = itemsPerComponent.get(cIdx) ?? [];
    bucket.push(item);
    itemsPerComponent.set(cIdx, bucket);
  }

  const regions: LayoutRegion[] = [];

  // One region per component that absorbed ≥1 OCR item. Bbox is the component
  // bbox (which spans the visual content), converted back to PDF points.
  const componentIndices = Array.from(itemsPerComponent.keys()).sort(
    (a, b) => a - b,
  );
  for (const cIdx of componentIndices) {
    const items = itemsPerComponent.get(cIdx)!;
    const comp = components[cIdx]!;
    const bbox = pixelBoxToPoints(comp, scaleX, scaleY);
    if (!bbox) continue;
    regions.push({
      bbox,
      hasLowConfidence: items.some(
        (it) => it.confidence !== undefined && it.confidence < threshold,
      ),
    });
  }

  if (orphans.length > 0) {
    regions.push(...clusterOrphans(orphans, threshold));
  }

  return regions;
}

function buildInkMask(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  threshold: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  // After .greyscale().raw() sharp emits 1 channel per pixel; guard anyway.
  if (channels === 1) {
    for (let i = 0; i < out.length; i++) {
      out[i] = data[i]! < threshold ? 1 : 0;
    }
    return out;
  }
  for (let i = 0, j = 0; i < out.length; i++, j += channels) {
    out[i] = data[j]! < threshold ? 1 : 0;
  }
  return out;
}

function resolveKernelSize(
  override: number | undefined,
  scaleY: number,
): number {
  if (override !== undefined) {
    return clamp(Math.round(override), 0, MAX_DILATION_KERNEL_PX);
  }
  const k = Math.round(DEFAULT_KERNEL_POINTS * scaleY);
  return clamp(k, MIN_DILATION_KERNEL_PX, MAX_DILATION_KERNEL_PX);
}

// Box dilation by a (k × k) kernel using separable prefix-sum range queries.
// Output[i,j] = 1 iff any pixel within [i±r, j±r] is ink. r = floor(k/2).
function dilateBox(
  src: Uint8Array,
  width: number,
  height: number,
  kernel: number,
): Uint8Array {
  const r = Math.floor(kernel / 2);
  if (r <= 0) return src;
  const horizontal = new Uint8Array(width * height);
  // Horizontal pass with running window count.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let count = 0;
    // Pre-fill window for column 0: pixels [0, r]
    for (let x = 0; x <= r && x < width; x++) {
      count += src[row + x]!;
    }
    horizontal[row] = count > 0 ? 1 : 0;
    for (let x = 1; x < width; x++) {
      const enter = x + r;
      const leave = x - r - 1;
      if (enter < width) count += src[row + enter]!;
      if (leave >= 0) count -= src[row + leave]!;
      horizontal[row + x] = count > 0 ? 1 : 0;
    }
  }
  const vertical = new Uint8Array(width * height);
  // Vertical pass on the horizontal output.
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y <= r && y < height; y++) {
      count += horizontal[y * width + x]!;
    }
    vertical[x] = count > 0 ? 1 : 0;
    for (let y = 1; y < height; y++) {
      const enter = y + r;
      const leave = y - r - 1;
      if (enter < height) count += horizontal[enter * width + x]!;
      if (leave >= 0) count -= horizontal[leave * width + x]!;
      vertical[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return vertical;
}

interface PixelBox {
  minX: number;
  minY: number;
  maxX: number; // inclusive
  maxY: number; // inclusive
  area: number;
}

// 4-connected components via two-pass union-find. Returns component bboxes
// whose pixel area meets minArea. Components are sorted by minY then minX.
function findComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minArea: number,
): PixelBox[] {
  const labels = new Int32Array(width * height);
  // 0 means unlabeled. Real labels start at 1.
  let nextLabel = 1;
  const parent: number[] = [0];

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    let cur = a;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] === 0) continue;
      const above = y > 0 ? labels[row - width + x]! : 0;
      const left = x > 0 ? labels[row + x - 1]! : 0;
      if (above === 0 && left === 0) {
        labels[row + x] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (above !== 0 && left !== 0) {
        const lbl = above < left ? above : left;
        labels[row + x] = lbl;
        if (above !== left) union(above, left);
      } else {
        labels[row + x] = above !== 0 ? above : left;
      }
    }
  }

  // Aggregate bboxes per root label.
  const boxes = new Map<number, PixelBox>();
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const raw = labels[row + x]!;
      if (raw === 0) continue;
      const root = find(raw);
      const box = boxes.get(root);
      if (!box) {
        boxes.set(root, { minX: x, minY: y, maxX: x, maxY: y, area: 1 });
      } else {
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y;
        if (y > box.maxY) box.maxY = y;
        box.area++;
      }
    }
  }

  const surviving: PixelBox[] = [];
  for (const box of boxes.values()) {
    if (box.area >= minArea) surviving.push(box);
  }
  surviving.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  return surviving;
}

function locateComponent(
  components: PixelBox[],
  cxPx: number,
  cyPx: number,
): number {
  for (let i = 0; i < components.length; i++) {
    const c = components[i]!;
    if (
      cxPx >= c.minX &&
      cxPx <= c.maxX &&
      cyPx >= c.minY &&
      cyPx <= c.maxY
    ) {
      return i;
    }
  }
  return -1;
}

function pixelBoxToPoints(
  box: PixelBox,
  scaleX: number,
  scaleY: number,
): BBox | null {
  const x = box.minX / scaleX;
  const y = box.minY / scaleY;
  const width = (box.maxX - box.minX + 1) / scaleX;
  const height = (box.maxY - box.minY + 1) / scaleY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width,
    height,
  };
}

// Row-stripe vertical clustering on OCR items in PDF points. Used as fallback
// when the page has no detectable ink, and for orphan OCR items that did not
// map to any ink component.
function clusterOrphans(
  items: GeoOcrItem[],
  threshold: number,
): LayoutRegion[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.yPt - b.yPt || a.xPt - b.xPt);
  const heights = sorted
    .map((it) => it.heightPt)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianHeight =
    heights.length === 0 ? 12 : heights[Math.floor(heights.length / 2)]!;
  const verticalGap = medianHeight * 2;

  const clusters: GeoOcrItem[][] = [];
  for (const item of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([item]);
      continue;
    }
    let lastBottom = -Infinity;
    for (const m of last) {
      const bottom = m.yPt + m.heightPt;
      if (bottom > lastBottom) lastBottom = bottom;
    }
    if (item.yPt - lastBottom <= verticalGap) {
      last.push(item);
    } else {
      clusters.push([item]);
    }
  }

  const regions: LayoutRegion[] = [];
  for (const cluster of clusters) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasLow = false;
    for (const it of cluster) {
      if (it.xPt < minX) minX = it.xPt;
      if (it.yPt < minY) minY = it.yPt;
      if (it.xPt + it.widthPt > maxX) maxX = it.xPt + it.widthPt;
      if (it.yPt + it.heightPt > maxY) maxY = it.yPt + it.heightPt;
      if (it.confidence !== undefined && it.confidence < threshold) hasLow = true;
    }
    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 0 || height <= 0) continue;
    regions.push({
      bbox: { x: Math.max(0, minX), y: Math.max(0, minY), width, height },
      hasLowConfidence: hasLow,
    });
  }
  return regions;
}

function toGeoOcrItem(item: OcrItem): GeoOcrItem | null {
  const x = numberOrUndefined(item.x);
  const y = numberOrUndefined(item.y);
  const width = numberOrUndefined(item.width);
  const height = numberOrUndefined(item.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return null;
  }
  if (width <= 0 || height <= 0 || x < 0 || y < 0) return null;
  return {
    xPt: x,
    yPt: y,
    widthPt: width,
    heightPt: height,
    confidence: numberOrUndefined(item.confidence),
  };
}

function anyLowConfidence(items: OcrItem[], threshold: number): boolean {
  for (const it of items) {
    const conf = numberOrUndefined(it.confidence);
    if (conf !== undefined && conf < threshold) return true;
  }
  return false;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
