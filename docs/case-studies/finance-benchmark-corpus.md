# Finance Benchmark Corpus Case Study

`agent-parse` was tested on finance benchmark papers to answer one question:
where does local parsing need an agent to look at the page?

## Framing

LiteParse parses the document. `agent-parse` reviews the suspicious visual
regions with a local agent CLI such as Claude Code or Codex.

The working model is:

```text
PDF
  -> LiteParse parse.json + page screenshots
  -> suspicious region detection
  -> visual-review-tasks.json
  -> local agent review
  -> corrections.json
  -> hybrid.json
```

## Why Finance Papers

Finance benchmark papers mix easy prose with hard visual content: architecture
diagrams, result tables, radar charts, workflow diagrams, small figure labels,
and multi-column layouts.

This was not a new finance benchmark. It was a parser workflow test.

## Results

The local corpus contained:

| Metric | Count |
|---|---:|
| PDFs | 24 |
| Pages | 502 |
| Flagged visual-review regions | 75 |
| Reviewed regions | 75 |
| Visual corrections | 75 |
| Final failed regions | 0 |

One region timed out at the default two-minute review timeout and passed with a
five-minute retry.

## What Worked

Body prose extraction was generally strong. The agent-review pass was most
useful on figure-heavy pages, where raw OCR often captured captions but garbled
internal labels.

## What To Trust

Use raw `parse.json` for:

- prose extraction
- bounding-box-aware text inspection
- page-level text previews
- finding suspicious pages

Prefer `hybrid.json` when:

- the page has figures or charts
- the parser emitted `suspicious-regions.json`
- downstream work depends on figure-internal labels or relationships

Still spot-check screenshots when:

- exact chart values matter
- the correction includes uncertainty
- the visual content is the core evidence for a claim

Visual corrections are auditable artifacts, not magic. For high-stakes
extraction, inspect the screenshot.

## Mini Example

See `examples/finance-benchmark-mini/` for a compact example based on the
Finance Agent Benchmark paper.

That example is intentionally small. The full corpus was roughly 269 MB locally, which is too large for a normal developer package.
