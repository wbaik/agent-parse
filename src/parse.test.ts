import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "./parse.js";
import type { AgentAdapter } from "./agents/index.js";
import type { FinalizeOptions } from "./finalize.js";
import type { PrepareOptions, PrepareResult } from "./prepare.js";

function prepareResult(): PrepareResult {
  return {
    outputDir: "out",
    parsePath: "out/parse.json",
    suspiciousRegionsPath: "out/suspicious-regions.json",
    taskManifestPath: "out/visual-review-tasks.json",
    regions: [],
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
  };
}

function emptyPrepareResult(): PrepareResult {
  return {
    outputDir: "out",
    parsePath: "out/parse.json",
    suspiciousRegionsPath: "out/suspicious-regions.json",
    taskManifestPath: "out/visual-review-tasks.json",
    regions: [],
    tasks: [],
  };
}

describe("parseDocument", () => {
  it("runs prepare, agent review, and finalize for autonomous agents", async () => {
    const prepareFn = vi.fn(async (_options: PrepareOptions) => prepareResult());
    const finalizeFn = vi.fn(async (_options: FinalizeOptions) => ({}));
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockResolvedValue({
        corrections: { source_pdf: "document.pdf", corrections: [] },
        taskResults: [
          {
            region_id: "page_2_region_1",
            page: 2,
            status: "confirmed",
            latency_ms: 100,
          },
        ],
      }),
    };

    await parseDocument({
      input: "document.pdf",
      outputDir: "out",
      agent: "codex",
      agentModel: "gpt-5.3-codex",
      prepareFn,
      finalizeFn,
      adapterFactory: () => adapter,
    });

    expect(prepareFn).toHaveBeenCalledOnce();
    expect(adapter.review).toHaveBeenCalledWith(
      expect.objectContaining({ agentModel: "gpt-5.3-codex" }),
    );
    expect(finalizeFn).toHaveBeenCalledWith({ outputDir: "out" });
  });

  it("skips adapter and finalize when prepare fails", async () => {
    const prepareFn = vi.fn(async (_options: PrepareOptions) => {
      throw new Error("parse failed");
    });
    const finalizeFn = vi.fn(async (_options: FinalizeOptions) => ({}));
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn(),
    };

    await expect(
      parseDocument({
        input: "document.pdf",
        outputDir: "out",
        agent: "codex",
        prepareFn,
        finalizeFn,
        adapterFactory: () => adapter,
      }),
    ).rejects.toThrow(/parse failed/);

    expect(adapter.review).not.toHaveBeenCalled();
    expect(finalizeFn).not.toHaveBeenCalled();
  });

  it("skips finalize when adapter fails", async () => {
    const prepareFn = vi.fn(async (_options: PrepareOptions) => prepareResult());
    const finalizeFn = vi.fn(async (_options: FinalizeOptions) => ({}));
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn().mockRejectedValue(new Error("agent failed")),
    };

    await expect(
      parseDocument({
        input: "document.pdf",
        outputDir: "out",
        agent: "codex",
        prepareFn,
        finalizeFn,
        adapterFactory: () => adapter,
      }),
    ).rejects.toThrow(/agent failed/);

    expect(finalizeFn).not.toHaveBeenCalled();
  });

  it("when no suspicious regions, finalize runs and adapter is skipped", async () => {
    const prepareFn = vi.fn(async (_options: PrepareOptions) => emptyPrepareResult());
    const finalizeFn = vi.fn(async (_options: FinalizeOptions) => ({}));
    const adapter: AgentAdapter = {
      name: "codex",
      review: vi.fn(),
    };

    await parseDocument({
      input: "document.pdf",
      outputDir: "out",
      agent: "codex",
      prepareFn,
      finalizeFn,
      adapterFactory: () => adapter,
    });

    expect(adapter.review).not.toHaveBeenCalled();
    expect(finalizeFn).toHaveBeenCalledWith({ outputDir: "out" });
  });

  it("manual mode runs prepare only", async () => {
    const prepareFn = vi.fn(async (_options: PrepareOptions) => prepareResult());
    const finalizeFn = vi.fn(async (_options: FinalizeOptions) => ({}));

    await parseDocument({
      input: "document.pdf",
      outputDir: "out",
      agent: "manual",
      prepareFn,
      finalizeFn,
      adapterFactory: () => {
        throw new Error("should not be called");
      },
    });

    expect(prepareFn).toHaveBeenCalledOnce();
    expect(finalizeFn).not.toHaveBeenCalled();
  });
});
