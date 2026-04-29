import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { BBox, SuspiciousRegion } from "./schemas.js";

export interface PageDimensions {
  widthPoints: number;
  heightPoints: number;
}

export interface WriteRegionCropsInput {
  regions: SuspiciousRegion[];
  shotsDir: string;
  pageDimensions?: Map<number, PageDimensions>;
  paddingPx?: number;
}

export type RegionCropResult =
  | {
      ok: true;
      region_id: string;
      page: number;
      crop: string;
    }
  | {
      ok: false;
      region_id: string;
      page: number;
      error: string;
    };

const DEFAULT_PADDING_PX = 24;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeRegionCrops(
  input: WriteRegionCropsInput,
): Promise<RegionCropResult[]> {
  const padding = input.paddingPx ?? DEFAULT_PADDING_PX;
  const results: RegionCropResult[] = [];

  for (const region of input.regions) {
    const pageImagePath = path.join(input.shotsDir, `page_${region.page}.png`);
    try {
      await access(pageImagePath);
    } catch {
      results.push({
        ok: false,
        region_id: region.region_id,
        page: region.page,
        error: `missing image: ${pageImagePath}`,
      });
      continue;
    }

    if (!region.bbox) {
      results.push({
        ok: true,
        region_id: region.region_id,
        page: region.page,
        crop: path.posix.join("shots", `page_${region.page}.png`),
      });
      continue;
    }

    const dims = input.pageDimensions?.get(region.page);
    if (!dims) {
      results.push({
        ok: false,
        region_id: region.region_id,
        page: region.page,
        error: `missing page dimensions for page ${region.page}`,
      });
      continue;
    }

    try {
      const cropName = `${region.region_id}.png`;
      const cropPath = path.join(input.shotsDir, cropName);
      const cropRel = path.posix.join("shots", cropName);
      await cropRegion({
        sourcePath: pageImagePath,
        destPath: cropPath,
        bbox: region.bbox,
        pageDimensions: dims,
        paddingPx: padding,
      });
      results.push({
        ok: true,
        region_id: region.region_id,
        page: region.page,
        crop: cropRel,
      });
    } catch (error) {
      results.push({
        ok: false,
        region_id: region.region_id,
        page: region.page,
        error: `crop failed: ${(error as Error).message}`,
      });
    }
  }

  return results;
}

interface CropRegionInput {
  sourcePath: string;
  destPath: string;
  bbox: BBox;
  pageDimensions: PageDimensions;
  paddingPx: number;
}

async function cropRegion(input: CropRegionInput): Promise<void> {
  const image = sharp(input.sourcePath);
  const metadata = await image.metadata();
  const widthPx = metadata.width;
  const heightPx = metadata.height;
  if (!widthPx || !heightPx) {
    throw new Error("source image has no dimensions");
  }

  const scaleX = widthPx / input.pageDimensions.widthPoints;
  const scaleY = heightPx / input.pageDimensions.heightPoints;
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    throw new Error("non-finite scale derived from page dimensions");
  }

  const rawLeft = input.bbox.x * scaleX - input.paddingPx;
  const rawTop = input.bbox.y * scaleY - input.paddingPx;
  const rawRight =
    (input.bbox.x + input.bbox.width) * scaleX + input.paddingPx;
  const rawBottom =
    (input.bbox.y + input.bbox.height) * scaleY + input.paddingPx;

  const left = clamp(Math.floor(rawLeft), 0, widthPx - 1);
  const top = clamp(Math.floor(rawTop), 0, heightPx - 1);
  const right = clamp(Math.ceil(rawRight), left + 1, widthPx);
  const bottom = clamp(Math.ceil(rawBottom), top + 1, heightPx);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error("computed crop has non-positive dimensions");
  }

  await image
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .toFile(input.destPath);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
