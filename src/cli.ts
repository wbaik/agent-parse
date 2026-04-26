import path from "node:path";
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import {
  createAgentAdapter,
  type AgentName,
} from "./agents/index.js";
import { runAgentEval } from "./eval.js";
import { finalize } from "./finalize.js";
import { parseDocument } from "./parse.js";
import { prepare } from "./prepare.js";
import { VisualReviewTaskManifestSchema } from "./schemas.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name("agent-parse")
    .description("Agentic visual review layer on top of LiteParse")
    .version("0.1.0");

  program
    .command("parse")
    .description("Prepare visual review tasks, optionally invoke an agent, and finalize")
    .argument("<file>", "Document to parse")
    .requiredOption("-o, --output <dir>", "Output directory")
    .option("--dpi <number>", "Render DPI", "300")
    .option(
      "--ocr-confidence-threshold <number>",
      "OCR confidence threshold",
      "0.8",
    )
    .option("--force", "Replace an existing output directory")
    .option("--agent <agent>", "Agent adapter: manual|codex|claude", "manual")
    .option("--agent-model <model>", "Model to pass to the agent CLI")
    .option(
      "--per-task-timeout-ms <number>",
      "Timeout per task in milliseconds (one CLI invocation per task)",
      "120000",
    )
    .action(async (file, options) => {
      await parseDocument({
        input: file,
        outputDir: options.output,
        force: Boolean(options.force),
        dpi: Number.parseInt(options.dpi, 10),
        ocrConfidenceThreshold: Number.parseFloat(
          options.ocrConfidenceThreshold,
        ),
        agent: parseAgentName(options.agent),
        agentModel: options.agentModel,
        perTaskTimeoutMs: Number.parseInt(options.perTaskTimeoutMs, 10),
      });
    });

  program
    .command("prepare")
    .description("Parse a document and prepare visual review tasks")
    .argument("<file>", "Document to parse")
    .requiredOption("-o, --output <dir>", "Output directory")
    .option("--dpi <number>", "Render DPI", "300")
    .option(
      "--ocr-confidence-threshold <number>",
      "OCR confidence threshold",
      "0.8",
    )
    .option("--force", "Replace an existing output directory")
    .action(async (file, options) => {
      await prepare({
        input: file,
        outputDir: options.output,
        force: Boolean(options.force),
        dpi: Number.parseInt(options.dpi, 10),
        ocrConfidenceThreshold: Number.parseFloat(
          options.ocrConfidenceThreshold,
        ),
      });
    });

  program
    .command("review")
    .description("Run an agent's visual review against an already-prepared output directory")
    .argument("<output-dir>", "Prepared output directory")
    .requiredOption("--agent <agent>", "Agent adapter: codex|claude")
    .option("--agent-model <model>", "Model to pass to the agent CLI")
    .option(
      "--per-task-timeout-ms <number>",
      "Timeout per task in milliseconds",
      "120000",
    )
    .option("--task-limit <number>", "Limit tasks for faster smoke tests")
    .action(async (outputDir, options) => {
      const agent = parseAgentName(options.agent);
      if (agent === "manual") {
        throw new Error("review requires codex or claude; manual cannot run reviews");
      }
      const resolvedDir = path.resolve(outputDir);
      const manifest = VisualReviewTaskManifestSchema.parse(
        JSON.parse(
          await readFile(path.join(resolvedDir, "visual-review-tasks.json"), "utf8"),
        ),
      );
      const tasks = options.taskLimit
        ? manifest.tasks.slice(0, Number.parseInt(options.taskLimit, 10))
        : manifest.tasks;
      const adapter = createAgentAdapter(agent);
      const outcome = await adapter.review({
        outputDir: resolvedDir,
        sourcePdf: path.resolve(resolvedDir, manifest.source_pdf),
        taskManifestPath: path.join(resolvedDir, "visual-review-tasks.json"),
        tasks,
        perTaskTimeoutMs: Number.parseInt(options.perTaskTimeoutMs, 10),
        agentModel: options.agentModel,
      });
      console.log(
        JSON.stringify(
          {
            agent,
            reviewed: outcome.taskResults.length,
            corrected: outcome.taskResults.filter((r) => r.status === "corrected").length,
            confirmed: outcome.taskResults.filter((r) => r.status === "confirmed").length,
            failed: outcome.taskResults.filter((r) => r.status === "failed").length,
          },
          null,
          2,
        ),
      );
    });

  program
    .command("eval-agent")
    .description("Run repeated agent visual reviews against a prepared output directory")
    .argument("<output-dir>", "Prepared output directory")
    .requiredOption("--agent <agent>", "Agent adapter: codex|claude")
    .option("--runs <number>", "Number of repeated review runs", "10")
    .option("--task-limit <number>", "Limit tasks per run for faster smoke tests")
    .option("--agent-model <model>", "Model to pass to the agent CLI")
    .option(
      "--per-task-timeout-ms <number>",
      "Timeout per task in milliseconds",
      "120000",
    )
    .action(async (outputDir, options) => {
      const summary = await runAgentEval({
        outputDir,
        agent: parseAgentName(options.agent),
        runs: Number.parseInt(options.runs, 10),
        perTaskTimeoutMs: Number.parseInt(options.perTaskTimeoutMs, 10),
        taskLimit: options.taskLimit
          ? Number.parseInt(options.taskLimit, 10)
          : undefined,
        agentModel: options.agentModel,
      });
      console.log(JSON.stringify(summary, null, 2));
    });

  program
    .command("finalize")
    .description("Merge visual corrections into a hybrid artifact")
    .argument("<output-dir>", "Prepared output directory")
    .action(async (outputDir) => {
      await finalize({ outputDir });
    });

  await program.parseAsync(argv);
}

function parseAgentName(value: string): AgentName {
  if (value === "manual" || value === "codex" || value === "claude") {
    return value;
  }
  throw new Error(`Invalid agent "${value}". Expected manual, codex, or claude.`);
}
