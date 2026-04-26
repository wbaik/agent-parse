# agent-parse

`agent-parse` asks a local agent to look where parsing is uncertain.

[`@llamaindex/liteparse`](https://github.com/run-llama/liteparse) gives the
fast local baseline: text, OCR metadata, bounding boxes, and page screenshots.
`agent-parse` detects suspicious visual regions, sends only those pages to
Claude Code or Codex, validates the response, and writes a hybrid artifact.

Use it for figures, charts, workflow diagrams, visual tables, and low-confidence
OCR regions. It is a review layer on top of LiteParse, not a replacement for it.

```text
PDF
  -> LiteParse parse.json + page screenshots
  -> suspicious region detection
  -> visual-review-tasks.json
  -> local agent review
  -> corrections.json
  -> hybrid.json
```

## Install

```bash
npm install
npm run build
```

`agent-parse` depends on `@llamaindex/liteparse`. For the base parser docs, see
the [LiteParse docs](https://developers.llamaindex.ai/liteparse/).

## Commands

```bash
node dist/index.js prepare <file>     -o <dir> [--dpi 300] [--ocr-confidence-threshold 0.8] [--force]
node dist/index.js review  <dir>      --agent codex|claude [--agent-model <model>] [--per-task-timeout-ms 120000] [--task-limit <n>]
node dist/index.js parse   <file>     -o <dir> [--agent manual|codex|claude] [--agent-model <model>] [--per-task-timeout-ms 120000] [--force]
node dist/index.js eval-agent <dir>   --agent codex|claude [--agent-model <model>] [--runs 10] [--task-limit <n>] [--per-task-timeout-ms 120000]
node dist/index.js finalize <dir>
```

`parse` is `prepare → review → finalize` glued together. The three building
blocks are independent so a human or another agent can step in between them.

## Why this exists

OCR can read characters. Agents can inspect visual meaning.

`agent-parse` keeps the cheap deterministic pass, then adds a semantic second
pass only where it is needed. The output keeps both layers: raw `parse.json`
plus reviewed visual corrections in `hybrid.json`.

## Case study: finance benchmark papers

During development, `agent-parse` was run on a local corpus of finance benchmark
papers:

| Metric | Count |
|---|---:|
| PDFs | 24 |
| Pages | 502 |
| Flagged visual-review regions | 75 |
| Reviewed regions | 75 |
| Visual corrections | 75 |
| Final failed regions | 0 |

Prose extraction was strong. Figures, charts, and workflow diagrams benefited
from visual review.

See `docs/case-studies/finance-benchmark-corpus.md`,
`docs/case-studies/finance-benchmark-eval-summary.md`, and
`examples/finance-benchmark-mini/`.

## How review works (read this before tuning timeouts)

The visual reviewer runs **one CLI invocation per suspicious region**. For each
flagged region the adapter:

1. Builds a single-task prompt that names the region, the page, and the image
   path the agent must read.
2. Spawns the agent CLI with that prompt (and, for Codex, attaches the image
   via `--image`; Claude reads the image path through its own tool use).
3. Waits up to `--per-task-timeout-ms` for the agent to exit. On timeout the
   process is SIGTERM'd and the task is recorded as `failed`; remaining tasks
   continue.
4. Parses the response as a `CorrectionsArtifact`. The agent must return zero
   or one corrections, and the `region_id` must match the task. Each task
   becomes one of three statuses:
   - `corrected`: agent returned one correction for this region.
   - `confirmed`: agent returned an empty `corrections[]` (deterministic
     extraction was fine, no correction needed).
   - `failed`: timeout, non-zero exit, malformed JSON, schema violation, or a
     `region_id` mismatch.
5. Aggregates all `corrected` entries into `corrections.json`. Per-task
   diagnostics land in `agent-review-log.json` and (on failures)
   `agent-review-error.json`.

This per-task design is deliberate. Earlier versions sent every task in one
giant prompt with all crops attached; that pattern hit single-call timeouts on
large documents and made it impossible to tell whether the agent had reasoned
about each region or had skipped silently.

## Empirical timings (so future agents don't have to rediscover them)

Measured against `finance-agent-benchmark.pdf` (24 pages, arXiv-style, 2 OCR
regions detected) on this hardware:

| Setup                                                | Wall time      | Notes                                            |
|------------------------------------------------------|----------------|--------------------------------------------------|
| `prepare` (LiteParse + screenshots, no agent)        | ~5 s           | Dominated by PDF render / OCR.                   |
| `review --agent claude --task-limit 1`               | ~24 s / task   | One Claude Sonnet call, full image read + JSON.  |
| `review --agent claude` for 2 tasks (this PDF)       | ~50–60 s       | Sequential, ~25 s per task.                      |
| `review --agent codex --agent-model gpt-5.3-codex`   | ~30–45 s / task| Vision-capable Codex; Spark is rejected.         |

**Rules of thumb when invoking from another agent or a script:**

- **Wall time scales linearly with task count.** A 30-region PDF reviewed by
  Claude will take ~10–15 minutes. Plan accordingly; do not assume "review"
  is fast.
- **Default `--per-task-timeout-ms` is 120 000 (2 min).** That has plenty of
  headroom for normal Sonnet/Codex calls but covers cold starts and slow
  uploads. Lower it to 60 000 only if you've measured that your model
  consistently finishes faster.
- **Trim with `--task-limit` first.** Before a full-document review, run
  `review … --task-limit 1` once to verify the agent CLI is reachable, the
  schema is satisfied, and the wall time per task matches expectations.
- **Don't try to "speed it up" by parallelizing tasks yourself.** The agent
  CLIs share local state (auth tokens, rate limits) and the per-task design
  is what gives you per-region failure isolation.
- **Detection is conservative on purpose.** A 24-page paper that previously
  flagged 12 regions now flags 2 — only pages where OCR actually fired or
  where embedded raster images exist. If you see zero suspicious regions on
  a document with no scanned content, that is the correct outcome.

## Manual workflow

```bash
node dist/index.js prepare ../finance-agent-benchmark.pdf -o out --force
```

This writes:

```text
out/
  parse.json                  Raw LiteParse JSON
  suspicious-regions.json     Regions selected for visual review
  visual-review-tasks.json    Agent-readable task manifest
  corrections-schema.json     Strict JSON schema for agent output
  shots/                      Full-page PNGs for every flagged page
```

A human or external agent can inspect `visual-review-tasks.json` and the
referenced images, then write `corrections.json`:

```json
{
  "source_pdf": "/abs/path/finance-agent-benchmark.pdf",
  "corrections": [
    {
      "page": 2,
      "region_id": "page_2_region_1",
      "crop": "shots/page_2.png",
      "kind": "figure",
      "corrected_extraction": {
        "summary": "Visible figure title and key labels.",
        "visible_text": ["FINANCE AGENT BENCHMARK"],
        "relationships": [],
        "uncertain": []
      },
      "notes": ""
    }
  ]
}
```

Finalize the hybrid artifact:

```bash
node dist/index.js finalize out
```

This writes `out/hybrid.json`. If `corrections.json` is absent, `finalize`
still produces a valid hybrid artifact with `source.corrections: null` and
`visual_corrections: []`.

## Autonomous agent workflow

Run prepare, invoke an agent adapter, and finalize in one command:

```bash
node dist/index.js parse ../finance-agent-benchmark.pdf -o out-codex --agent codex --agent-model gpt-5.3-codex --force
node dist/index.js parse ../finance-agent-benchmark.pdf -o out-claude --agent claude --force
```

Agent defaults:

- `claude`: defaults to `claude-sonnet-4-6`. Override with `--agent-model`.
- `codex`: uses the Codex CLI default unless `--agent-model` is provided. Use
  a vision-capable model such as `gpt-5.3-codex`. The adapter rejects
  `gpt-5.3-codex-spark`, which is text-only and unsuitable for image review.

The adapters call local CLIs non-interactively, one task at a time:

```text
codex exec --skip-git-repo-check [--model M] --output-schema corrections-schema.json --output-last-message agent-review-output.json --image <abs/crop> <prompt>
claude -p --model M --output-format json --json-schema <schema> <prompt>
```

For Claude, the image path is included in the prompt; Claude reads it via its
built-in `Read` tool. For Codex, the image is attached directly via `--image`.

## Review-only workflow

If you've already run `prepare` and want to re-run the agent without redoing
the parse:

```bash
node dist/index.js review out-prepare --agent claude --task-limit 2
```

This is the fastest way to iterate when tuning prompts or comparing agents.

## Reliability testing

Use `eval-agent` to run repeated reviews against an already-prepared
directory. The summary distinguishes `corrected` / `confirmed` / `failed`
counts so you can tell apart "agent worked, no correction needed" from
"agent silently produced an empty result":

```bash
node dist/index.js prepare    ../finance-agent-benchmark.pdf -o out-eval --force
node dist/index.js eval-agent out-eval --agent claude --runs 5 --task-limit 1
node dist/index.js eval-agent out-eval --agent codex  --runs 5 --task-limit 1 --agent-model gpt-5.3-codex
```

`agent-eval-summary.json` has both per-run counts and per-task latency,
which is what to look at when comparing model variants.

## Outputs

```text
parse.json                 Raw LiteParse JSON
suspicious-regions.json    Regions selected for visual review
visual-review-tasks.json   Agent-readable crop review tasks
corrections-schema.json    Strict JSON schema for agent output
corrections.json           Validated agent or human corrections (one entry per "corrected" task)
hybrid.json                Raw parse output plus visual corrections
agent-review-raw.txt       Concatenated raw agent stdout per task (for debugging)
agent-review-log.json      Per-task status (corrected|confirmed|failed) and latency_ms
agent-review-error.json    Per-task error diagnostics, when any task fails
agent-review-output.json   Codex --output-last-message file (per task; overwritten between tasks)
agent-eval-summary.json    Repeated-run evaluation summary
```

`hybrid.json` preserves the raw parse output and appends visual corrections
with provenance back to `page`, `region_id`, and the source image path.

## Failure behavior

- Missing input fails before creating output.
- Existing non-empty output fails unless `--force` is used.
- No suspicious regions still produces a valid `visual-review-tasks.json`
  (with `tasks: []`) and `parse` runs `finalize` directly.
- Missing page shots are recorded on their region and do not erase `parse.json`.
- Invalid `corrections.json` does not overwrite an existing `hybrid.json`.
- A task that times out, exits non-zero, returns invalid JSON, or returns a
  correction for the wrong `region_id` is marked `failed`. Remaining tasks
  still run.
- A run is `ok` only when every task succeeded; "agent reviewed nothing" is
  not silently reported as success.

## Verification

```bash
npm test
npm run typecheck
npm run build
```
