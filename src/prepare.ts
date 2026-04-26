import { rm, access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LiteParse } from "@llamaindex/liteparse";
import { detectSuspiciousRegions } from "./detect.js";
import { writeRegionCrops } from "./images.js";
import {
  type SuspiciousRegion,
  type VisualReviewTask,
  type VisualReviewTaskManifest,
  CorrectionsArtifactJsonSchema,
} from "./schemas.js";

export interface LiteParseAdapter {
  parse(input: string): Promise<unknown>;
  screenshot(
    input: string,
    pages: number[],
  ): Promise<Array<{ pageNum: number; imageBuffer: Buffer }>>;
}

export interface PrepareOptions {
  input: string;
  outputDir: string;
  force?: boolean;
  dpi?: number;
  ocrConfidenceThreshold?: number;
  adapter?: LiteParseAdapter;
}

export interface PrepareResult {
  outputDir: string;
  parsePath: string;
  suspiciousRegionsPath: string;
  taskManifestPath: string;
  regions: SuspiciousRegion[];
  tasks: VisualReviewTask[];
}

export class LiteParseLibraryAdapter implements LiteParseAdapter {
  constructor(private readonly dpi: number) {}

  async parse(input: string): Promise<unknown> {
    const parser = new LiteParse({ outputFormat: "json", dpi: this.dpi });
    const result = await parser.parse(input, true);
    return result.json ?? { pages: result.pages };
  }

  async screenshot(input: string, pages: number[]) {
    const parser = new LiteParse({ dpi: this.dpi });
    return parser.screenshot(input, pages, true);
  }
}

export async function prepare(options: PrepareOptions): Promise<PrepareResult> {
  await assertFileExists(options.input);
  await prepareOutputDir(options.outputDir, Boolean(options.force));

  const dpi = options.dpi ?? 300;
  const adapter = options.adapter ?? new LiteParseLibraryAdapter(dpi);
  const parseJson = await adapter.parse(options.input);
  const parsePath = path.join(options.outputDir, "parse.json");
  await writeJson(parsePath, parseJson);

  const regions = detectSuspiciousRegions(parseJson, {
    ocrConfidenceThreshold: options.ocrConfidenceThreshold,
  });

  const pages = Array.from(new Set(regions.map((region) => region.page))).sort(
    (a, b) => a - b,
  );
  const shotsDir = path.join(options.outputDir, "shots");
  if (regions.length > 0) {
    await mkdir(shotsDir, { recursive: true });
  }

  if (pages.length > 0) {
    const screenshots = await adapter.screenshot(options.input, pages);
    for (const screenshot of screenshots) {
      await writeFile(
        path.join(shotsDir, `page_${screenshot.pageNum}.png`),
        screenshot.imageBuffer,
      );
    }
  }

  const cropResults = await writeRegionCrops({
    regions,
    shotsDir,
  });
  const cropByRegion = new Map(
    cropResults.map((result) => [result.region_id, result]),
  );

  const regionsWithCrops = regions.map((region) => {
    const crop = cropByRegion.get(region.region_id);
    if (!crop) {
      return region;
    }
    if (crop.ok) {
      return { ...region, crop: crop.crop };
    }
    return { ...region, error: crop.error };
  });

  const suspiciousRegionsPath = path.join(
    options.outputDir,
    "suspicious-regions.json",
  );
  await writeJson(suspiciousRegionsPath, regionsWithCrops);

  const tasks = regionsWithCrops
    .filter((region): region is SuspiciousRegion & { crop: string } =>
      Boolean(region.crop),
    )
    .map((region) => createTask(region));
  const manifest: VisualReviewTaskManifest = {
    source_pdf: path.resolve(options.input),
    tasks,
    correction_schema: CorrectionsArtifactJsonSchema,
  };

  const taskManifestPath = path.join(
    options.outputDir,
    "visual-review-tasks.json",
  );
  await writeJson(taskManifestPath, manifest);
  await writeJson(
    path.join(options.outputDir, "corrections-schema.json"),
    CorrectionsArtifactJsonSchema,
  );

  return {
    outputDir: options.outputDir,
    parsePath,
    suspiciousRegionsPath,
    taskManifestPath,
    regions: regionsWithCrops,
    tasks,
  };
}

function createTask(
  region: SuspiciousRegion & { crop: string },
): VisualReviewTask {
  return {
    region_id: region.region_id,
    page: region.page,
    kind: region.kind,
    crop: region.crop,
    reasons: region.reasons,
    prompt:
      "Inspect this crop visually. Extract the exact visible labels, values, and relationships as structured JSON. Return only valid corrections JSON.",
  };
}

async function assertFileExists(file: string): Promise<void> {
  try {
    await access(file);
  } catch {
    throw new Error(`Input file not found: ${file}`);
  }
}

async function prepareOutputDir(outputDir: string, force: boolean): Promise<void> {
  if (force) {
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    return;
  }

  try {
    const entries = await readdir(outputDir);
    if (entries.length > 0) {
      throw new Error(
        `Output directory is not empty: ${outputDir}. Use --force to replace it.`,
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
    await mkdir(outputDir, { recursive: true });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
