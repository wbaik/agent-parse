import type {
  Correction,
  CorrectionsArtifact,
  VisualReviewTask,
} from "../schemas.js";

export type AgentName = "manual" | "codex" | "claude";

export interface ReviewContext {
  outputDir: string;
  sourcePdf: string;
  taskManifestPath: string;
  tasks: VisualReviewTask[];
  perTaskTimeoutMs: number;
  agentModel?: string;
}

export type AgentTaskResult =
  | {
      region_id: string;
      page: number;
      status: "corrected";
      correction: Correction;
      latency_ms: number;
    }
  | {
      region_id: string;
      page: number;
      status: "confirmed";
      latency_ms: number;
    }
  | {
      region_id: string;
      page: number;
      status: "failed";
      error: string;
      latency_ms: number;
    };

export interface AgentReviewOutcome {
  corrections: CorrectionsArtifact;
  taskResults: AgentTaskResult[];
}

export interface AgentAdapter {
  name: AgentName;
  review(context: ReviewContext): Promise<AgentReviewOutcome>;
}
