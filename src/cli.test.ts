import { describe, expect, it, vi } from "vitest";

const runAgentEvalMock = vi.hoisted(() =>
  vi.fn(async () => ({
    agent: "codex" as const,
    runs: 10,
    per_task_timeout_ms: 30000,
    totals: { reviewed: 20, corrected: 5, confirmed: 14, failed: 1 },
    full_success_runs: 9,
    any_failure_runs: 1,
    results: [],
  })),
);

vi.mock("./eval.js", () => ({
  runAgentEval: runAgentEvalMock,
}));

import { runCli } from "./cli.js";

describe("runCli", () => {
  it("runs repeated agent evaluation from the eval-agent command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli([
      "node",
      "agent-parse",
      "eval-agent",
      "prepared",
      "--agent",
      "codex",
      "--runs",
      "10",
      "--per-task-timeout-ms",
      "30000",
      "--task-limit",
      "2",
      "--agent-model",
      "gpt-5.3-codex-spark",
    ]);

    expect(runAgentEvalMock).toHaveBeenCalledWith({
      outputDir: "prepared",
      agent: "codex",
      runs: 10,
      perTaskTimeoutMs: 30000,
      taskLimit: 2,
      agentModel: "gpt-5.3-codex-spark",
    });
    expect(log).toHaveBeenCalled();

    log.mockRestore();
  });
});
