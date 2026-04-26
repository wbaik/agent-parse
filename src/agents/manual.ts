import type {
  AgentAdapter,
  AgentReviewOutcome,
  ReviewContext,
} from "./interface.js";

export class ManualAdapter implements AgentAdapter {
  name = "manual" as const;

  async review(_context: ReviewContext): Promise<AgentReviewOutcome> {
    throw new Error(
      "Manual review pending. Fill corrections.json, then run agent-parse finalize.",
    );
  }
}
