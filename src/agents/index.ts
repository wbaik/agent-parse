import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import type { AgentAdapter, AgentName } from "./interface.js";
import { ManualAdapter } from "./manual.js";

export function createAgentAdapter(name: AgentName): AgentAdapter {
  switch (name) {
    case "manual":
      return new ManualAdapter();
    case "codex":
      return createCodexAdapter();
    case "claude":
      return createClaudeAdapter();
  }
}

export type {
  AgentAdapter,
  AgentName,
  AgentReviewOutcome,
  AgentTaskResult,
  ReviewContext,
} from "./interface.js";
