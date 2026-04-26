import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentEval } from "./eval.js";
import type { AgentAdapter } from "./agents/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-eval-"));
  await writeFile(
    path.join(dir, "visual-review-tasks.json"),
    JSON.stringify({
      source_pdf: "document.pdf",
      tasks: [
        {
          region_id: "page_2_region_1",
          page: 2,
          kind: "figure",
          crop: "shots/page_2.png",
          reasons: ["ocr_text", "figure_caption"],
          prompt: "Extract",
        },
      ],
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runAgentEval", () => {
  it("counts corrected/confirmed/failed across runs", async () => {
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockResolvedValue({
        corrections: {
          source_pdf: "document.pdf",
          corrections: [
            {
              page: 2,
              region_id: "page_2_region_1",
              crop: "shots/page_2.png",
              kind: "figure",
              corrected_extraction: {
                summary: "x",
                visible_text: ["x"],
                relationships: [],
                uncertain: [],
              },
              notes: "",
            },
          ],
        },
        taskResults: [
          {
            region_id: "page_2_region_1",
            page: 2,
            status: "corrected",
            correction: {
              page: 2,
              region_id: "page_2_region_1",
              crop: "shots/page_2.png",
              kind: "figure",
              corrected_extraction: {
                summary: "x",
                visible_text: ["x"],
                relationships: [],
                uncertain: [],
              },
              notes: "",
            },
            latency_ms: 100,
          },
        ],
      }),
    };

    const summary = await runAgentEval({
      outputDir: dir,
      agent: "codex",
      agentModel: "gpt-5.3-codex",
      runs: 3,
      adapterFactory: () => adapter,
    });

    expect(summary.runs).toBe(3);
    expect(summary.full_success_runs).toBe(3);
    expect(summary.totals.corrected).toBe(3);
    expect(summary.totals.failed).toBe(0);
    const written = JSON.parse(
      await readFile(path.join(dir, "agent-eval-summary.json"), "utf8"),
    );
    expect(written.totals.corrected).toBe(3);
  });

  it("flags a run as ok=false when any task failed (no silent success on zero corrections)", async () => {
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockResolvedValue({
        corrections: { source_pdf: "document.pdf", corrections: [] },
        taskResults: [
          {
            region_id: "page_2_region_1",
            page: 2,
            status: "failed",
            error: "timed out",
            latency_ms: 100,
          },
        ],
      }),
    };

    const summary = await runAgentEval({
      outputDir: dir,
      agent: "codex",
      runs: 1,
      adapterFactory: () => adapter,
    });

    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.totals.failed).toBe(1);
    expect(summary.any_failure_runs).toBe(1);
  });

  it("records adapter throws as a fully-failed run", async () => {
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockRejectedValue(new Error("boom")),
    };

    const summary = await runAgentEval({
      outputDir: dir,
      agent: "codex",
      runs: 1,
      adapterFactory: () => adapter,
    });

    expect(summary.results[0]?.ok).toBe(false);
    expect(summary.results[0]?.error).toMatch(/boom/);
    expect(summary.totals.failed).toBe(1);
  });

  it("can limit tasks for fast repeated smoke tests", async () => {
    await writeFile(
      path.join(dir, "visual-review-tasks.json"),
      JSON.stringify({
        source_pdf: "document.pdf",
        tasks: [
          {
            region_id: "page_2_region_1",
            page: 2,
            kind: "figure",
            crop: "shots/page_2.png",
            reasons: ["ocr_text"],
            prompt: "Extract",
          },
          {
            region_id: "page_5_region_1",
            page: 5,
            kind: "figure",
            crop: "shots/page_5.png",
            reasons: ["ocr_text"],
            prompt: "Extract",
          },
        ],
      }),
    );
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockResolvedValue({
        corrections: { source_pdf: "document.pdf", corrections: [] },
        taskResults: [
          {
            region_id: "page_2_region_1",
            page: 2,
            status: "confirmed",
            latency_ms: 50,
          },
        ],
      }),
    };

    await runAgentEval({
      outputDir: dir,
      agent: "codex",
      runs: 1,
      taskLimit: 1,
      agentModel: "gpt-5.3-codex",
      adapterFactory: () => adapter,
    });

    expect(adapter.review).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ region_id: "page_2_region_1" })],
        agentModel: "gpt-5.3-codex",
      }),
    );
  });
});
