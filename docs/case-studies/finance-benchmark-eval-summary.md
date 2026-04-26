# Finance Benchmark Eval Summary

This eval checked whether `agent-parse` can find uncertain visual regions in real papers and produce auditable corrections.

It was not a model-accuracy benchmark. It was a parser workflow check.

## Result

| Metric | Count |
|---|---:|
| PDFs | 24 |
| Pages parsed | 502 |
| Papers with flagged regions | 13 |
| Visual regions flagged | 75 |
| Regions reviewed with Claude Code | 75 |
| Corrections written to `hybrid.json` | 75 |
| Final failed regions | 0 |

One BizBench region timed out at the default two-minute timeout and passed with a five-minute retry.

## Per-Paper Review Counts

| Paper | Reviewed regions | Pages |
|---|---:|---|
| AlphaForgeBench | 23 | 6, 8, 51, 52, 54-56, 58, 60-62, 65, 67-77 |
| Open FinLLM Leaderboard | 20 | 1, 4, 5, 7, 11-26 |
| BizFinBench | 8 | 2, 7, 13-15, 18, 21, 24 |
| FinTagging | 7 | 3-5, 8-10, 14 |
| FinBen | 3 | 21-23 |
| FinTradeBench | 3 | 1, 4, 5 |
| Finance Agent Benchmark | 2 | 2, 5 |
| FinEval | 2 | 8, 18 |
| FinRetrieval | 2 | 4, 9 |
| InvestorBench | 2 | 4, 5 |
| BizBench | 1 | 23 |
| ConvFinQA | 1 | 12 |
| FinanceBench | 1 | 1 |

## What The Agent Reviewed

The reviewed regions were mostly figures and visual tables:

- benchmark architecture diagrams
- harness and workflow diagrams
- leaderboard screenshots
- radar charts and return curves
- table-like financial statement pages
- small labels inside charts and diagrams

## Representative Corrections

### Finance Agent Benchmark

The parser flagged a harness architecture figure. The agent described the flow from `INPUT` to `LLM` to `OUTPUT`, and identified supporting tools such as Google Search, EDGAR search, HTML parsing, retrieval, and a database.

### BizBench

The parser flagged a contractual obligations page. The agent recovered the table context: maturities by year, rows such as debt service and purchase obligations, and the surrounding explanatory notes.

### FinRetrieval

The parser flagged a question-generation pipeline and a WebOnly-vs-MCP accuracy plot. The agent described the phases, visual hierarchy, and the model comparison pattern shown by the chart.

### AlphaForgeBench

The parser flagged radar charts and cumulative return plots. The agent summarized axes, temperature settings, compared model traces, and noted where exact chart values should still be checked visually.

## Takeaway

Raw parsing was good enough for normal prose. Visual review mattered when information lived in layout, arrows, chart geometry, or figure labels.

`agent-parse` works best when treated as an auditable second pass: use LiteParse for the baseline, then use a local agent to inspect only the uncertain visual regions.
