# Finance Benchmark Mini Example

This is a small real example of `agent-parse` reviewing a figure that LiteParse
flagged as uncertain.

Source paper:

- `Finance Agent Benchmark: Benchmarking LLMs on Real-world Financial Research Tasks`
- arXiv: <https://arxiv.org/abs/2508.00828>

## Included Files

```text
manifest.json
finance-agent-benchmark/
  suspicious-regions.json
  corrections.json
  hybrid.excerpt.json
  shots/
    page_5.png
```

## What To Look At

Start with `suspicious-regions.json`. It contains one page-level region flagged
because the deterministic parse saw OCR text, low confidence, and a figure
caption.

Then compare:

- `shots/page_5.png`: the visual evidence
- `corrections.json`: agent-generated visual-review corrections
- `hybrid.excerpt.json`: raw parse excerpt plus visual correction

## Why This Example Exists

LiteParse parses the document. `agent-parse` asks a local agent to look where
the parse is uncertain. The output keeps the screenshot, correction, and page
provenance together.

## Corpus Context

The full local finance benchmark corpus used during development had:

- 24 PDFs
- 502 pages
- 75 flagged visual-review regions
- 75 reviewed regions
- 75 visual corrections
- 0 failed regions after retrying one timeout with a longer timeout

The full corpus is not included because it is large. This example is just enough
to understand the workflow.
