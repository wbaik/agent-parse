import path from "node:path";
import { CorrectionsArtifactJsonSchema } from "../schemas.js";
import { ShellAgentAdapter } from "./shell.js";
import type { ReviewContext } from "./interface.js";
import type { VisualReviewTask } from "../schemas.js";

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

export interface CreateClaudeAdapterOptions {
  commandOverride?: string;
}

export function createClaudeAdapter(
  options: CreateClaudeAdapterOptions = {},
): ShellAgentAdapter {
  const override = options.commandOverride ?? process.env.AGENT_PARSE_CLAUDE_COMMAND;
  return new ShellAgentAdapter({
    name: "claude",
    command: override ? path.resolve(override) : "claude",
    buildArgs: buildClaudeArgs,
  });
}

function buildClaudeArgs(
  context: ReviewContext,
  _task: VisualReviewTask,
  prompt: string,
): string[] {
  return [
    "-p",
    "--model",
    context.agentModel ?? DEFAULT_CLAUDE_MODEL,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(CorrectionsArtifactJsonSchema),
    prompt,
  ];
}
