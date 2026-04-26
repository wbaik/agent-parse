import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CorrectionsArtifactSchema,
  type Correction,
  type CorrectionsArtifact,
  type VisualReviewTask,
} from "../schemas.js";
import type {
  AgentAdapter,
  AgentName,
  AgentReviewOutcome,
  AgentTaskResult,
  ReviewContext,
} from "./interface.js";

export type BuildArgsForTask = (
  context: ReviewContext,
  task: VisualReviewTask,
  prompt: string,
) => string[];

export interface ShellAgentAdapterOptions {
  name: Exclude<AgentName, "manual">;
  command: string;
  buildArgs: BuildArgsForTask;
  outputFile?: string;
}

export class ShellAgentAdapter implements AgentAdapter {
  readonly name: Exclude<AgentName, "manual">;
  private readonly command: string;
  private readonly buildArgs: BuildArgsForTask;
  readonly outputFileForTest?: string;

  constructor(options: ShellAgentAdapterOptions) {
    this.name = options.name;
    this.command = options.command;
    this.buildArgs = options.buildArgs;
    this.outputFileForTest = options.outputFile;
  }

  async review(context: ReviewContext): Promise<AgentReviewOutcome> {
    const taskResults: AgentTaskResult[] = [];
    const aggregatedCorrections: Correction[] = [];

    for (const task of context.tasks) {
      const result = await this.reviewSingle(context, task);
      taskResults.push(result);
      if (result.status === "corrected") {
        aggregatedCorrections.push(result.correction);
      }
    }

    const corrections: CorrectionsArtifact = {
      source_pdf: context.sourcePdf,
      corrections: aggregatedCorrections,
    };

    await writeJson(path.join(context.outputDir, "agent-review-log.json"), {
      agent: this.name,
      tasks: taskResults,
    });

    const allFailed =
      context.tasks.length > 0 &&
      taskResults.every((result) => result.status === "failed");
    if (allFailed) {
      const firstError = taskResults.find(
        (result): result is AgentTaskResult & { status: "failed"; error: string } =>
          result.status === "failed",
      );
      throw new Error(
        firstError
          ? `Agent ${this.name} failed every task. First error: ${firstError.error}`
          : `Agent ${this.name} produced no task results`,
      );
    }

    await writeJson(path.join(context.outputDir, "corrections.json"), corrections);
    return { corrections, taskResults };
  }

  buildArgsForTest(
    context: ReviewContext,
    task: VisualReviewTask,
    prompt: string,
  ): string[] {
    return this.buildArgs(context, task, prompt);
  }

  private async reviewSingle(
    context: ReviewContext,
    task: VisualReviewTask,
  ): Promise<AgentTaskResult> {
    const prompt = buildReviewPrompt(context, task);
    const args = this.buildArgs(context, task, prompt);
    const startedAt = Date.now();

    const outputFilePath = this.outputFileForTest
      ? path.join(context.outputDir, this.outputFileForTest)
      : undefined;
    if (outputFilePath) {
      await unlink(outputFilePath).catch(() => undefined);
    }

    let stdout = "";
    let stderr = "";
    try {
      const result = await runShellCommand(this.command, args, {
        cwd: context.outputDir,
        timeout: context.perTaskTimeoutMs,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      const message = `Agent ${this.name} exited with code ${String(err.code ?? "unknown")} on ${task.region_id}: ${err.message}`;
      await appendErrorLog(context.outputDir, this.name, task, {
        stdout: err.stdout,
        stderr: err.stderr,
        code: err.code,
        message: err.message,
      });
      return {
        region_id: task.region_id,
        page: task.page,
        status: "failed",
        error: message,
        latency_ms: Date.now() - startedAt,
      };
    }

    const rawOutput = outputFilePath
      ? await readOptionalFile(outputFilePath, stdout)
      : stdout;
    await appendRawLog(context.outputDir, task, rawOutput);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      const message = `Agent ${this.name} did not return valid JSON for ${task.region_id}`;
      await appendErrorLog(context.outputDir, this.name, task, {
        stdout,
        stderr,
        raw_output: rawOutput,
        message,
      });
      return {
        region_id: task.region_id,
        page: task.page,
        status: "failed",
        error: message,
        latency_ms: Date.now() - startedAt,
      };
    }

    let artifact: CorrectionsArtifact;
    try {
      artifact = CorrectionsArtifactSchema.parse(unwrapStructuredOutput(parsed));
    } catch (error) {
      const message = `Agent ${this.name} returned a payload that does not match the corrections schema for ${task.region_id}: ${(error as Error).message}`;
      await appendErrorLog(context.outputDir, this.name, task, {
        stdout,
        stderr,
        raw_output: rawOutput,
        message,
      });
      return {
        region_id: task.region_id,
        page: task.page,
        status: "failed",
        error: message,
        latency_ms: Date.now() - startedAt,
      };
    }

    const matching = artifact.corrections.filter(
      (correction) => correction.region_id === task.region_id,
    );
    const foreign = artifact.corrections.filter(
      (correction) => correction.region_id !== task.region_id,
    );
    if (foreign.length > 0) {
      const message = `Agent ${this.name} returned correction(s) for unknown region(s) on ${task.region_id}: ${foreign.map((c) => c.region_id).join(", ")}`;
      await appendErrorLog(context.outputDir, this.name, task, {
        stdout,
        stderr,
        raw_output: rawOutput,
        message,
      });
      return {
        region_id: task.region_id,
        page: task.page,
        status: "failed",
        error: message,
        latency_ms: Date.now() - startedAt,
      };
    }

    if (matching.length > 1) {
      const message = `Agent ${this.name} returned more than one correction for ${task.region_id}`;
      await appendErrorLog(context.outputDir, this.name, task, {
        stdout,
        stderr,
        raw_output: rawOutput,
        message,
      });
      return {
        region_id: task.region_id,
        page: task.page,
        status: "failed",
        error: message,
        latency_ms: Date.now() - startedAt,
      };
    }

    if (matching.length === 0) {
      return {
        region_id: task.region_id,
        page: task.page,
        status: "confirmed",
        latency_ms: Date.now() - startedAt,
      };
    }

    return {
      region_id: task.region_id,
      page: task.page,
      status: "corrected",
      correction: matching[0]!,
      latency_ms: Date.now() - startedAt,
    };
  }
}

export function buildReviewPrompt(
  context: ReviewContext,
  task: VisualReviewTask,
): string {
  const cropAbsolute = path.join(context.outputDir, task.crop);
  return [
    `You are reviewing a single document image for agent-parse, region ${task.region_id} on page ${task.page}.`,
    "Read the image at this path before answering. The deterministic parser flagged this region for visual review:",
    cropAbsolute,
    `Reasons it was flagged: ${task.reasons.join(", ")}.`,
    'Decide ONE of two outcomes: (a) the deterministic extraction is correct and you have nothing to add — return {"source_pdf": "...", "corrections": []}; (b) you can extract additional or corrected detail from the image — return one correction object with region_id exactly equal to the value below.',
    `Required region_id: ${task.region_id}`,
    `Required crop path (echo verbatim): ${task.crop}`,
    `Required page: ${task.page}`,
    `Required kind: ${task.kind}`,
    "Return ONLY valid JSON conforming to the corrections artifact schema. Do not wrap the JSON in markdown. Do not include commentary before or after the JSON. If a detail is not visible, omit it from visible_text or list it under uncertain. Do not invent content.",
    `Source PDF: ${context.sourcePdf}`,
  ].join("\n\n");
}

async function appendRawLog(
  outputDir: string,
  task: VisualReviewTask,
  rawOutput: string,
): Promise<void> {
  const file = path.join(outputDir, "agent-review-raw.txt");
  const block = `--- ${task.region_id} ---\n${rawOutput}${rawOutput.endsWith("\n") ? "" : "\n"}`;
  await appendFile(file, block);
}

async function appendErrorLog(
  outputDir: string,
  agent: string,
  task: VisualReviewTask,
  details: {
    stdout?: string;
    stderr?: string;
    raw_output?: string;
    code?: number | string;
    message: string;
  },
): Promise<void> {
  const file = path.join(outputDir, "agent-review-error.json");
  let existing: { entries?: unknown[] } = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    existing = {};
  }
  const entries = Array.isArray(existing.entries) ? existing.entries : [];
  entries.push({
    agent,
    region_id: task.region_id,
    page: task.page,
    ...details,
  });
  await writeJson(file, { entries });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendFile(file: string, contents: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(file, existing + contents);
}

async function readOptionalFile(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function unwrapStructuredOutput(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "structured_output" in value &&
    (value as { structured_output?: unknown }).structured_output
  ) {
    return (value as { structured_output: unknown }).structured_output;
  }
  return value;
}

interface RunShellCommandOptions {
  cwd: string;
  timeout: number;
}

interface RunShellCommandResult {
  stdout: string;
  stderr: string;
}

function runShellCommand(
  command: string,
  args: string[],
  options: RunShellCommandOptions,
): Promise<RunShellCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeout);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0 && !timedOut) {
        resolve(result);
        return;
      }

      const error = new Error(
        timedOut
          ? `Command timed out after ${options.timeout}ms`
          : signal
            ? `Command failed with signal ${signal}`
            : `Command failed with code ${String(code)}`,
      ) as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      error.code = timedOut ? "ETIMEDOUT" : (signal ?? code ?? undefined);
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      reject(error);
    });
  });
}
