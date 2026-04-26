import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentAdapter,
  type AgentAdapter,
  type AgentName,
  type AgentTaskResult,
} from "./agents/index.js";
import { VisualReviewTaskManifestSchema } from "./schemas.js";

export interface AgentEvalOptions {
  outputDir: string;
  agent: AgentName;
  agentModel?: string;
  runs: number;
  taskLimit?: number;
  perTaskTimeoutMs?: number;
  adapterFactory?: (name: AgentName) => AgentAdapter;
}

export interface AgentEvalRunResult {
  run: number;
  ok: boolean;
  reviewed: number;
  corrected: number;
  confirmed: number;
  failed: number;
  task_results: AgentTaskResult[];
  error?: string;
}

export interface AgentEvalSummary {
  agent: AgentName;
  runs: number;
  per_task_timeout_ms: number;
  totals: {
    reviewed: number;
    corrected: number;
    confirmed: number;
    failed: number;
  };
  full_success_runs: number;
  any_failure_runs: number;
  results: AgentEvalRunResult[];
}

export async function runAgentEval(
  options: AgentEvalOptions,
): Promise<AgentEvalSummary> {
  if (options.agent === "manual") {
    throw new Error("eval-agent requires codex or claude; manual cannot run reviews");
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error("runs must be a positive integer");
  }
  if (
    options.taskLimit !== undefined &&
    (!Number.isInteger(options.taskLimit) || options.taskLimit < 1)
  ) {
    throw new Error("taskLimit must be a positive integer");
  }

  const outputDir = path.resolve(options.outputDir);
  const taskManifestPath = path.join(outputDir, "visual-review-tasks.json");
  const manifest = VisualReviewTaskManifestSchema.parse(
    JSON.parse(await readFile(taskManifestPath, "utf8")),
  );
  const adapterFactory = options.adapterFactory ?? createAgentAdapter;
  const adapter = adapterFactory(options.agent);
  const tasks = options.taskLimit
    ? manifest.tasks.slice(0, options.taskLimit)
    : manifest.tasks;
  const perTaskTimeoutMs = options.perTaskTimeoutMs ?? 120000;
  const results: AgentEvalRunResult[] = [];

  for (let index = 0; index < options.runs; index += 1) {
    const run = index + 1;
    try {
      const outcome = await adapter.review({
        outputDir,
        sourcePdf: path.resolve(outputDir, manifest.source_pdf),
        taskManifestPath,
        tasks,
        perTaskTimeoutMs,
        agentModel: options.agentModel,
      });
      const counts = countTaskResults(outcome.taskResults);
      results.push({
        run,
        ok: counts.failed === 0,
        ...counts,
        task_results: outcome.taskResults,
      });
    } catch (error) {
      results.push({
        run,
        ok: false,
        reviewed: tasks.length,
        corrected: 0,
        confirmed: 0,
        failed: tasks.length,
        task_results: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const totals = results.reduce(
    (acc, result) => ({
      reviewed: acc.reviewed + result.reviewed,
      corrected: acc.corrected + result.corrected,
      confirmed: acc.confirmed + result.confirmed,
      failed: acc.failed + result.failed,
    }),
    { reviewed: 0, corrected: 0, confirmed: 0, failed: 0 },
  );

  const summary: AgentEvalSummary = {
    agent: options.agent,
    runs: options.runs,
    per_task_timeout_ms: perTaskTimeoutMs,
    totals,
    full_success_runs: results.filter((r) => r.failed === 0).length,
    any_failure_runs: results.filter((r) => r.failed > 0).length,
    results,
  };

  await writeFile(
    path.join(outputDir, "agent-eval-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  return summary;
}

function countTaskResults(taskResults: AgentTaskResult[]) {
  return {
    reviewed: taskResults.length,
    corrected: taskResults.filter((r) => r.status === "corrected").length,
    confirmed: taskResults.filter((r) => r.status === "confirmed").length,
    failed: taskResults.filter((r) => r.status === "failed").length,
  };
}
