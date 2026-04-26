import { z } from "zod";

export const RegionKindSchema = z.enum([
  "figure",
  "table",
  "chart",
  "ocr",
  "page",
  "unknown",
]);

export const BBoxSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

export const SuspiciousRegionSchema = z.object({
  page: z.number().int().positive(),
  region_id: z.string().min(1),
  kind: RegionKindSchema,
  reasons: z.array(z.string().min(1)).min(1),
  bbox: BBoxSchema.nullable(),
  crop: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const VisualReviewTaskSchema = z.object({
  region_id: z.string().min(1),
  page: z.number().int().positive(),
  kind: RegionKindSchema,
  crop: z.string().min(1),
  reasons: z.array(z.string().min(1)).min(1),
  prompt: z.string().min(1),
});

export const VisualReviewTaskManifestSchema = z.object({
  source_pdf: z.string().min(1),
  tasks: z.array(VisualReviewTaskSchema),
  correction_schema: z.record(z.unknown()).optional(),
});

export const CorrectionSchema = z.object({
  page: z.number().int().positive(),
  region_id: z.string().min(1),
  crop: z.string().min(1),
  kind: RegionKindSchema,
  corrected_extraction: z.record(z.unknown()),
  notes: z.string().optional(),
});

export const CorrectionsArtifactSchema = z.object({
  source_pdf: z.string().min(1),
  corrections: z.array(CorrectionSchema),
});

export const CorrectionsArtifactJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["source_pdf", "corrections"],
  properties: {
    source_pdf: { type: "string" },
    corrections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "page",
          "region_id",
          "crop",
          "kind",
          "corrected_extraction",
          "notes",
        ],
        properties: {
          page: { type: "integer", minimum: 1 },
          region_id: { type: "string", minLength: 1 },
          crop: { type: "string", minLength: 1 },
          kind: {
            type: "string",
            enum: ["figure", "table", "chart", "ocr", "page", "unknown"],
          },
          corrected_extraction: {
            type: "object",
            additionalProperties: false,
            required: ["summary", "visible_text", "relationships", "uncertain"],
            properties: {
              summary: { type: "string" },
              visible_text: {
                type: "array",
                items: { type: "string" },
              },
              relationships: {
                type: "array",
                items: { type: "string" },
              },
              uncertain: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          notes: { type: "string" },
        },
      },
    },
  },
} as const;

export const HybridArtifactSchema = z.object({
  source: z.object({
    parse: z.string().min(1),
    suspicious_regions: z.string().min(1),
    corrections: z.string().min(1).nullable(),
  }),
  parse: z.unknown(),
  suspicious_regions: z.array(SuspiciousRegionSchema),
  visual_corrections: z.array(CorrectionSchema),
});

export const AgentReviewResultSchema = z.object({
  status: z.enum(["pending", "completed", "failed"]),
  corrections: CorrectionsArtifactSchema.optional(),
  error: z.string().optional(),
  raw_output: z.string().optional(),
});

export type RegionKind = z.infer<typeof RegionKindSchema>;
export type BBox = z.infer<typeof BBoxSchema>;
export type SuspiciousRegion = z.infer<typeof SuspiciousRegionSchema>;
export type VisualReviewTask = z.infer<typeof VisualReviewTaskSchema>;
export type VisualReviewTaskManifest = z.infer<
  typeof VisualReviewTaskManifestSchema
>;
export type Correction = z.infer<typeof CorrectionSchema>;
export type CorrectionsArtifact = z.infer<typeof CorrectionsArtifactSchema>;
export type HybridArtifact = z.infer<typeof HybridArtifactSchema>;
export type AgentReviewResult = z.infer<typeof AgentReviewResultSchema>;
