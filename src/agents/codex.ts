import path from "node:path";
import { ShellAgentAdapter } from "./shell.js";
import type { ReviewContext } from "./interface.js";
import type { VisualReviewTask } from "../schemas.js";

export interface CreateCodexAdapterOptions {
  commandOverride?: string;
}

export function createCodexAdapter(
  options: CreateCodexAdapterOptions = {},
): ShellAgentAdapter {
  const override = options.commandOverride ?? process.env.AGENT_PARSE_CODEX_COMMAND;
  return new ShellAgentAdapter({
    name: "codex",
    command: override ? path.resolve(override) : "codex",
    buildArgs: buildCodexArgs,
    outputFile: "agent-review-output.json",
  });
}

function buildCodexArgs(
  context: ReviewContext,
  task: VisualReviewTask,
  prompt: string,
): string[] {
  if (context.agentModel?.toLowerCase().includes("spark")) {
    throw new Error(
      "GPT-5.3-Codex-Spark appears to be text-only in Codex and is not suitable for image-based visual review tasks. Use a vision-capable Codex model such as gpt-5.3-codex.",
    );
  }

  return [
    "exec",
    "--skip-git-repo-check",
    ...(context.agentModel ? ["--model", context.agentModel] : []),
    "--output-schema",
    "corrections-schema.json",
    "--output-last-message",
    "agent-review-output.json",
    "--image",
    path.join(context.outputDir, task.crop),
    prompt,
  ];
}
