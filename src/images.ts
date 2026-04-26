import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SuspiciousRegion } from "./schemas.js";

export interface WriteRegionCropsInput {
  regions: SuspiciousRegion[];
  shotsDir: string;
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

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeRegionCrops(
  input: WriteRegionCropsInput,
): Promise<RegionCropResult[]> {
  const results: RegionCropResult[] = [];

  for (const region of input.regions) {
    const pageImagePath = path.join(input.shotsDir, `page_${region.page}.png`);
    const shotsRelative = path.posix.join("shots", `page_${region.page}.png`);

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
    results.push({
      ok: true,
      region_id: region.region_id,
      page: region.page,
      crop: shotsRelative,
    });
  }

  return results;
}
