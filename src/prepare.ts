import { rm, access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LiteParse } from "@llamaindex/liteparse";
import { findPagesNeedingReview, type PageCandidate } from "./detect.js";
import { writeRegionCrops, type PageDimensions } from "./images.js";
import { segmentPageLayout, type LayoutRegion } from "./layout.js";
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

  const candidates = findPagesNeedingReview(parseJson);
  const shotsDir = path.join(options.outputDir, "shots");
  if (candidates.length > 0) {
    await mkdir(shotsDir, { recursive: true });
  }

  const pageImagePaths = await screenshotCandidates(
    adapter,
    options.input,
    candidates,
    shotsDir,
  );

  const regions = await buildRegions({
    candidates,
    pageImagePaths,
    ocrConfidenceThreshold: options.ocrConfidenceThreshold,
  });

  const pageDimensions = pageDimensionsFromCandidates(candidates);
  const cropResults = await writeRegionCrops({
    regions,
    shotsDir,
    pageDimensions,
  });
  const cropByRegion = new Map(
    cropResults.map((result) => [result.region_id, result]),
  );

  const regionsWithCrops = regions.map((region) => {
    const crop = cropByRegion.get(region.region_id);
    if (!crop) return region;
    if (crop.ok) return { ...region, crop: crop.crop };
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
    .map(createTask);
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

async function screenshotCandidates(
  adapter: LiteParseAdapter,
  input: string,
  candidates: PageCandidate[],
  shotsDir: string,
): Promise<Map<number, string>> {
  const pageImagePaths = new Map<number, string>();
  if (candidates.length === 0) return pageImagePaths;
  const pageNums = candidates.map((c) => c.page);
  const screenshots = await adapter.screenshot(input, pageNums);
  for (const shot of screenshots) {
    const file = path.join(shotsDir, `page_${shot.pageNum}.png`);
    await writeFile(file, shot.imageBuffer);
    pageImagePaths.set(shot.pageNum, file);
  }
  return pageImagePaths;
}

interface BuildRegionsInput {
  candidates: PageCandidate[];
  pageImagePaths: Map<number, string>;
  ocrConfidenceThreshold: number | undefined;
}

async function buildRegions(
  input: BuildRegionsInput,
): Promise<SuspiciousRegion[]> {
  const out: SuspiciousRegion[] = [];
  for (const candidate of input.candidates) {
    const imagePath = input.pageImagePaths.get(candidate.page);
    const layoutRegions = imagePath
      ? await segmentPageLayout({
          imagePath,
          pageDimensions: candidate.pageDimensions,
          ocrItems: candidate.ocrItems,
          ocrConfidenceThreshold: input.ocrConfidenceThreshold,
        })
      : geometryLessFallback(candidate, input.ocrConfidenceThreshold);
    layoutRegions.forEach((region, idx) => {
      out.push(toSuspiciousRegion(candidate.page, idx + 1, region));
    });
  }
  return out;
}

function geometryLessFallback(
  candidate: PageCandidate,
  thresholdOverride: number | undefined,
): LayoutRegion[] {
  const threshold = thresholdOverride ?? 0.8;
  const hasLow = candidate.ocrItems.some(
    (it) => typeof it.confidence === "number" && it.confidence < threshold,
  );
  return [{ bbox: null, hasLowConfidence: hasLow }];
}

function toSuspiciousRegion(
  page: number,
  index: number,
  region: LayoutRegion,
): SuspiciousRegion {
  const reasons = ["ocr_text"];
  if (region.hasLowConfidence) reasons.push("low_ocr_confidence");
  return {
    page,
    region_id: `page_${page}_region_${index}`,
    kind: "unknown",
    reasons,
    bbox: region.bbox,
  };
}

function pageDimensionsFromCandidates(
  candidates: PageCandidate[],
): Map<number, PageDimensions> {
  const out = new Map<number, PageDimensions>();
  for (const c of candidates) {
    if (c.pageDimensions) out.set(c.page, c.pageDimensions);
  }
  return out;
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
    if (code !== "ENOENT") throw error;
    await mkdir(outputDir, { recursive: true });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
