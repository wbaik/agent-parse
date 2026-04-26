import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CorrectionsArtifactSchema,
  SuspiciousRegionSchema,
  type HybridArtifact,
} from "./schemas.js";

export interface FinalizeOptions {
  outputDir: string;
}

export async function finalize(options: FinalizeOptions): Promise<HybridArtifact> {
  const parsePath = path.join(options.outputDir, "parse.json");
  const suspiciousRegionsPath = path.join(
    options.outputDir,
    "suspicious-regions.json",
  );
  const correctionsPath = path.join(options.outputDir, "corrections.json");
  const hybridPath = path.join(options.outputDir, "hybrid.json");
  const tmpPath = path.join(options.outputDir, "hybrid.json.tmp");

  const parseJson = await readJson(parsePath, "parse.json");
  const suspiciousRegionsRaw = await readJson(
    suspiciousRegionsPath,
    "suspicious-regions.json",
  );
  const correctionsRaw = await readOptionalJson(correctionsPath);

  const suspiciousRegions = SuspiciousRegionSchema.array().parse(
    suspiciousRegionsRaw,
  );
  const corrections = correctionsRaw
    ? CorrectionsArtifactSchema.parse(correctionsRaw)
    : { source_pdf: "", corrections: [] };

  const hybrid: HybridArtifact = {
    source: {
      parse: "parse.json",
      suspicious_regions: "suspicious-regions.json",
      corrections: correctionsRaw ? "corrections.json" : null,
    },
    parse: parseJson,
    suspicious_regions: suspiciousRegions,
    visual_corrections: corrections.corrections,
  };

  await writeFile(tmpPath, `${JSON.stringify(hybrid, null, 2)}\n`);
  await rename(tmpPath, hybridPath);
  return hybrid;
}

async function readJson(file: string, label: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`Required ${label} not found at ${file}`);
    }
    throw error;
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label}: ${message}`);
  }
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  try {
    return await readJson(file, "corrections.json");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Required corrections.json not found")
    ) {
      return undefined;
    }
    throw error;
  }
}
