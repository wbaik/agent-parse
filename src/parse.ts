import path from "node:path";
import {
  createAgentAdapter,
  type AgentAdapter,
  type AgentName,
} from "./agents/index.js";
import { finalize, type FinalizeOptions } from "./finalize.js";
import { prepare, type PrepareOptions, type PrepareResult } from "./prepare.js";

export interface ParseDocumentOptions extends PrepareOptions {
  agent?: AgentName;
  agentModel?: string;
  perTaskTimeoutMs?: number;
  prepareFn?: (options: PrepareOptions) => Promise<PrepareResult>;
  finalizeFn?: (options: FinalizeOptions) => Promise<unknown>;
  adapterFactory?: (name: AgentName) => AgentAdapter;
}

export async function parseDocument(
  options: ParseDocumentOptions,
): Promise<PrepareResult> {
  const agent = options.agent ?? "manual";
  const prepareFn = options.prepareFn ?? prepare;
  const finalizeFn = options.finalizeFn ?? finalize;
  const adapterFactory = options.adapterFactory ?? createAgentAdapter;

  const result = await prepareFn(options);
  if (agent === "manual") {
    return result;
  }

  if (result.tasks.length === 0) {
    await finalizeFn({ outputDir: result.outputDir });
    return result;
  }

  const adapter = adapterFactory(agent);
  await adapter.review({
    outputDir: result.outputDir,
    sourcePdf: path.resolve(options.input),
    taskManifestPath: result.taskManifestPath,
    tasks: result.tasks,
    perTaskTimeoutMs: options.perTaskTimeoutMs ?? 120000,
    agentModel: options.agentModel,
  });
  await finalizeFn({ outputDir: result.outputDir });
  return result;
}
