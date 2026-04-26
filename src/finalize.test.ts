import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalize } from "./finalize.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-parse-finalize-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeBaseArtifacts() {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "parse.json"),
    JSON.stringify({ pages: [{ page: 2, text: "body" }] }),
  );
  await writeFile(
    path.join(dir, "suspicious-regions.json"),
    JSON.stringify([
      {
        page: 2,
        region_id: "page_2_region_1",
        kind: "figure",
        reasons: ["figure_caption"],
        bbox: null,
        crop: "crops/page_2_region_1.png",
      },
    ]),
  );
}

describe("finalize", () => {
  it("writes hybrid.json for valid corrections", async () => {
    await writeBaseArtifacts();
    await writeFile(
      path.join(dir, "corrections.json"),
      JSON.stringify({
        source_pdf: "document.pdf",
        corrections: [
          {
            page: 2,
            region_id: "page_2_region_1",
            crop: "crops/page_2_region_1.png",
            kind: "figure",
            corrected_extraction: { title: "Corrected figure" },
          },
        ],
      }),
    );

    await finalize({ outputDir: dir });

    const hybrid = JSON.parse(
      await readFile(path.join(dir, "hybrid.json"), "utf8"),
    );
    expect(hybrid.visual_corrections).toHaveLength(1);
    expect(hybrid.parse.pages[0].page).toBe(2);
  });

  it("writes an empty visual correction set with null source.corrections when corrections.json is missing", async () => {
    await writeBaseArtifacts();

    await finalize({ outputDir: dir });

    const hybrid = JSON.parse(
      await readFile(path.join(dir, "hybrid.json"), "utf8"),
    );
    expect(hybrid.source.corrections).toBeNull();
    expect(hybrid.visual_corrections).toEqual([]);
  });

  it("rejects invalid corrections and leaves existing hybrid unchanged", async () => {
    await writeBaseArtifacts();
    await writeFile(path.join(dir, "hybrid.json"), "existing");
    await writeFile(
      path.join(dir, "corrections.json"),
      JSON.stringify({ source_pdf: "document.pdf", corrections: "bad" }),
    );

    await expect(finalize({ outputDir: dir })).rejects.toThrow();
    expect(await readFile(path.join(dir, "hybrid.json"), "utf8")).toBe(
      "existing",
    );
  });
});
