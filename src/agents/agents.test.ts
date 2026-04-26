import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualAdapter } from "./manual.js";
import { buildReviewPrompt, ShellAgentAdapter } from "./shell.js";
import type { ReviewContext } from "./interface.js";
import { createCodexAdapter } from "./codex.js";
import { createClaudeAdapter, DEFAULT_CLAUDE_MODEL } from "./claude.js";
import type { VisualReviewTask } from "../schemas.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-agents-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TASK: VisualReviewTask = {
  region_id: "page_2_region_1",
  page: 2,
  kind: "figure",
  crop: "shots/page_2.png",
  reasons: ["ocr_text", "figure_caption"],
  prompt: "Extract figure labels.",
};

function context(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    outputDir: dir,
    sourcePdf: "document.pdf",
    taskManifestPath: path.join(dir, "visual-review-tasks.json"),
    perTaskTimeoutMs: 5000,
    tasks: [TASK],
    ...overrides,
  };
}

const PASSTHROUGH_BUILD_ARGS = (
  _ctx: ReviewContext,
  _task: VisualReviewTask,
  prompt: string,
) => [prompt];

async function script(name: string, source: string) {
  const file = path.join(dir, name);
  await writeFile(file, source);
  await chmod(file, 0o755);
  return file;
}

describe("agent adapters", () => {
  it("manual adapter reports review is pending", async () => {
    await expect(new ManualAdapter().review(context())).rejects.toThrow(
      /manual review pending/i,
    );
  });

  it("shell adapter parses one correction per task into the corrections artifact", async () => {
    const command = await script(
      "valid.mjs",
      `#!/usr/bin/env node
console.log(JSON.stringify({
  source_pdf: "document.pdf",
  corrections: [{
    page: 2,
    region_id: "page_2_region_1",
    crop: "shots/page_2.png",
    kind: "figure",
    corrected_extraction: { summary: "Correct", visible_text: [], relationships: [], uncertain: [] },
    notes: ""
  }]
}));
`,
    );

    const outcome = await new ShellAgentAdapter({
      name: "codex",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
    }).review(context());

    expect(outcome.corrections.corrections).toHaveLength(1);
    expect(outcome.taskResults[0]?.status).toBe("corrected");
    const written = JSON.parse(
      await readFile(path.join(dir, "corrections.json"), "utf8"),
    );
    expect(written.corrections[0].region_id).toBe("page_2_region_1");
  });

  it("shell adapter treats empty corrections as 'confirmed' (no silent success)", async () => {
    const command = await script(
      "confirmed.mjs",
      `#!/usr/bin/env node
console.log(JSON.stringify({
  source_pdf: "document.pdf",
  corrections: []
}));
`,
    );

    const outcome = await new ShellAgentAdapter({
      name: "codex",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
    }).review(context());

    expect(outcome.corrections.corrections).toHaveLength(0);
    expect(outcome.taskResults[0]?.status).toBe("confirmed");
  });

  it("shell adapter records invalid JSON as a failed task", async () => {
    const command = await script(
      "invalid-json.mjs",
      `#!/usr/bin/env node
console.log("not json");
`,
    );

    await expect(
      new ShellAgentAdapter({
        name: "codex",
        command,
        buildArgs: PASSTHROUGH_BUILD_ARGS,
      }).review(context()),
    ).rejects.toThrow(/failed every task/i);

    const raw = await readFile(path.join(dir, "agent-review-raw.txt"), "utf8");
    expect(raw).toContain("page_2_region_1");
    expect(raw).toContain("not json");
    const error = JSON.parse(
      await readFile(path.join(dir, "agent-review-error.json"), "utf8"),
    );
    expect(error.entries[0]).toMatchObject({ region_id: "page_2_region_1" });
  });

  it("shell adapter parses Claude structured_output wrappers", async () => {
    const command = await script(
      "structured-output.mjs",
      `#!/usr/bin/env node
console.log(JSON.stringify({
  type: "result",
  structured_output: {
    source_pdf: "document.pdf",
    corrections: [{
      page: 2,
      region_id: "page_2_region_1",
      crop: "shots/page_2.png",
      kind: "figure",
      corrected_extraction: { summary: "x", visible_text: [], relationships: [], uncertain: [] },
      notes: ""
    }]
  }
}));
`,
    );

    const outcome = await new ShellAgentAdapter({
      name: "claude",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
    }).review(context());

    expect(outcome.corrections.corrections[0]?.region_id).toBe("page_2_region_1");
  });

  it("shell adapter prefers an output file when present", async () => {
    const command = await script(
      "response-file.mjs",
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("agent-review-output.json", JSON.stringify({
  source_pdf: "document.pdf",
  corrections: [{
    page: 2,
    region_id: "page_2_region_1",
    crop: "shots/page_2.png",
    kind: "figure",
    corrected_extraction: { summary: "x", visible_text: [], relationships: [], uncertain: [] },
    notes: ""
  }]
}));
console.log("agent log line");
`,
    );

    const outcome = await new ShellAgentAdapter({
      name: "codex",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
      outputFile: "agent-review-output.json",
    }).review(context());

    expect(outcome.corrections.corrections).toHaveLength(1);
    expect(await readFile(path.join(dir, "agent-review-raw.txt"), "utf8")).toContain(
      "source_pdf",
    );
  });

  it("shell adapter falls back to stdout when the configured response file is absent", async () => {
    const command = await script(
      "missing-response-file.mjs",
      `#!/usr/bin/env node
console.log(JSON.stringify({
  source_pdf: "document.pdf",
  corrections: [{
    page: 2,
    region_id: "page_2_region_1",
    crop: "shots/page_2.png",
    kind: "figure",
    corrected_extraction: { summary: "x", visible_text: [], relationships: [], uncertain: [] },
    notes: ""
  }]
}));
`,
    );

    const outcome = await new ShellAgentAdapter({
      name: "codex",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
      outputFile: "agent-review-output.json",
    }).review(context());

    expect(outcome.corrections.corrections).toHaveLength(1);
  });

  it("isolates per-task failures: one bad task does not block another", async () => {
    const command = await script(
      "selective.mjs",
      `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1];
if (prompt.includes("page_5_region_1")) {
  console.error("boom");
  process.exit(2);
}
console.log(JSON.stringify({
  source_pdf: "document.pdf",
  corrections: [{
    page: 2,
    region_id: "page_2_region_1",
    crop: "shots/page_2.png",
    kind: "figure",
    corrected_extraction: { summary: "x", visible_text: [], relationships: [], uncertain: [] },
    notes: ""
  }]
}));
`,
    );

    const ctx = context({
      tasks: [
        TASK,
        {
          ...TASK,
          region_id: "page_5_region_1",
          page: 5,
          crop: "shots/page_5.png",
        },
      ],
    });
    const outcome = await new ShellAgentAdapter({
      name: "codex",
      command,
      buildArgs: PASSTHROUGH_BUILD_ARGS,
    }).review(ctx);

    expect(outcome.taskResults).toHaveLength(2);
    expect(outcome.taskResults[0]?.status).toBe("corrected");
    expect(outcome.taskResults[1]?.status).toBe("failed");
    expect(outcome.corrections.corrections).toHaveLength(1);
  });

  it("shell adapter rejects corrections whose region_id does not match the task", async () => {
    const command = await script(
      "wrong-region.mjs",
      `#!/usr/bin/env node
console.log(JSON.stringify({
  source_pdf: "document.pdf",
  corrections: [{
    page: 2,
    region_id: "page_999_region_1",
    crop: "shots/page_999.png",
    kind: "figure",
    corrected_extraction: { summary: "x", visible_text: [], relationships: [], uncertain: [] },
    notes: ""
  }]
}));
`,
    );

    await expect(
      new ShellAgentAdapter({
        name: "codex",
        command,
        buildArgs: PASSTHROUGH_BUILD_ARGS,
      }).review(context()),
    ).rejects.toThrow(/failed every task/i);

    const error = JSON.parse(
      await readFile(path.join(dir, "agent-review-error.json"), "utf8"),
    );
    expect(error.entries[0].message).toMatch(/unknown region/i);
  });

  it("shell adapter records non-zero exit as a failed task", async () => {
    const command = await script(
      "fail.mjs",
      `#!/usr/bin/env node
console.error("boom");
process.exit(2);
`,
    );

    await expect(
      new ShellAgentAdapter({
        name: "codex",
        command,
        buildArgs: PASSTHROUGH_BUILD_ARGS,
      }).review(context()),
    ).rejects.toThrow(/failed every task/i);

    await expect(readFile(path.join(dir, "corrections.json"))).rejects.toThrow();
    const error = JSON.parse(
      await readFile(path.join(dir, "agent-review-error.json"), "utf8"),
    );
    expect(error.entries[0].stderr).toContain("boom");
  });

  it("builds a single-task prompt with crop verification and JSON-only instructions", () => {
    const prompt = buildReviewPrompt(context(), TASK);

    expect(prompt).toContain("Return ONLY valid JSON");
    expect(prompt).toContain("Do not wrap the JSON in markdown");
    expect(prompt).toContain("page_2_region_1");
    expect(prompt).toContain(path.join(dir, "shots/page_2.png"));
    expect(prompt).not.toContain("TypeScript");
  });

  it("codex adapter attaches the per-task crop image and output schema", () => {
    const adapter = createCodexAdapter({ commandOverride: "codex" });
    const args = adapter.buildArgsForTest(context(), TASK, "PROMPT");

    expect(args).toContain("exec");
    expect(args).toContain("--image");
    expect(args).toContain(path.join(dir, "shots/page_2.png"));
    expect(args).toContain("--output-schema");
    expect(args).toContain("--output-last-message");
    expect(args).toContain("agent-review-output.json");
    expect(adapter.outputFileForTest).toBe("agent-review-output.json");
    expect(args[args.length - 1]).toBe("PROMPT");
  });

  it("codex adapter passes an explicit vision-capable model to codex exec", () => {
    const adapter = createCodexAdapter({ commandOverride: "codex" });
    const args = adapter.buildArgsForTest(
      { ...context(), agentModel: "gpt-5.3-codex" },
      TASK,
      "PROMPT",
    );

    expect(args).toContain("--model");
    expect(args).toContain("gpt-5.3-codex");
  });

  it("codex adapter rejects Spark for image-based visual review tasks", () => {
    const adapter = createCodexAdapter({ commandOverride: "codex" });

    expect(() =>
      adapter.buildArgsForTest(
        { ...context(), agentModel: "gpt-5.3-codex-spark" },
        TASK,
        "PROMPT",
      ),
    ).toThrow(/Spark.*text-only/i);
  });

  it("claude adapter constrains output with the corrections JSON schema", () => {
    const adapter = createClaudeAdapter({ commandOverride: "claude" });
    const args = adapter.buildArgsForTest(context(), TASK, "PROMPT");
    const schemaIndex = args.indexOf("--json-schema");

    expect(args).toContain("-p");
    expect(args).toContain("--model");
    expect(args).toContain(DEFAULT_CLAUDE_MODEL);
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(JSON.parse(args[schemaIndex + 1] ?? "")).toMatchObject({
      type: "object",
      required: ["source_pdf", "corrections"],
    });
    expect(args).toContain("PROMPT");
  });

  it("claude adapter allows explicit model override", () => {
    const adapter = createClaudeAdapter({ commandOverride: "claude" });
    const args = adapter.buildArgsForTest(
      { ...context(), agentModel: "claude-haiku-4-5-20251001" },
      TASK,
      "PROMPT",
    );

    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4-5-20251001");
    expect(args).not.toContain(DEFAULT_CLAUDE_MODEL);
  });
});
