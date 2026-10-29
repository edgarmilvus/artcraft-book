# Board deck audit report

- Deck: `chapter18/solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/output/work/out/helios-board-2026-09.deck`
- PDF: `chapter18/solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/output/work/out/helios-board-2026-09.pdf`
- Binding map: `chapter18/solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/output/work/out/bindings.json`
- Converged: **False** (reason: `blocking-only`)
- Wall clock: 5328 ms

## The bound figures

| slide | frame | slot | source | value |
| --- | --- | --- | --- | --- |
| 0 | 259 | kpi.revenue | `helios-consolidated!Helios.Revenue.Q3` | Net revenue: $164.2M |
| 0 | 260 | kpi.ebitda | `helios-consolidated!Helios.Ebitda.Q3` | EBITDA: $40.2M |
| 0 | 261 | kpi.netincome | `helios-consolidated!Helios.NetIncome.Q3` | Net income: $16.9M |
| 0 | 262 | kpi.fcf | `helios-consolidated!Helios.FreeCashFlow.Q3` | Free cash flow: $8.0M |
| 0 | 263 | kpi.grossmargin | `helios-consolidated!Helios.GrossMargin.Pct` | Gross margin: 56.33% |
| 0 | 264 | kpi.netmargin | `helios-consolidated!Helios.NetMargin.Pct` | Net margin: 10.27% |
| 1 | 267 | bridge.chart | `helios-consolidated!Scenarios!A1:C4` | 3 categories, 2 series |
| 1 | 268 | bridge.revenue | `helios-consolidated!Helios.Revenue.Q3` | Net revenue: $164.2M |
| 1 | 269 | bridge.ebitda | `helios-consolidated!Helios.Ebitda.Q3` | EBITDA: $40.2M |
| 2 | 272 | scenario.base | `helios-consolidated!Scenarios!B2` | Base: $164.2M |
| 2 | 273 | scenario.upside | `helios-consolidated!Scenarios!B3` | Upside: $177.3M |
| 2 | 274 | scenario.downside | `helios-consolidated!Scenarios!B4` | Downside: $152.7M |
| 3 | 278 | close.reconciled | `close-reconciliation!Helios.Close.Reconciled` | Reconciled net revenue: $164.3M |
| 3 | 279 | close.items | `close-reconciliation!Helios.Close.Items` | Items raised: $125K |
| 3 | 280 | close.unresolved | `close-reconciliation!Helios.Close.Unresolved` | Unresolved: $40K |
| 3 | 281 | close.variance | `close-reconciliation!Helios.Close.Variance` | Variance to the audited close: $85K |

## The iterations

### Iteration 1

- slide 0: `898efc26e277` -> `898efc26e277` (0 correction(s), reviewer answered in 2 attempt(s))
- slide 1: `8d84a6471755` -> `8d84a6471755` (0 correction(s), reviewer answered in 1 attempt(s))
- slide 2: `861efca292f7` -> `5fba460fc648` (3 correction(s), reviewer answered in 1 attempt(s))
- slide 3: `0c687e595237` -> `0c687e595237` (0 correction(s), reviewer answered in 1 attempt(s))

### Iteration 2

- slide 0: `898efc26e277` -> `898efc26e277` (0 correction(s), reviewer answered in 1 attempt(s))
- slide 1: `8d84a6471755` -> `8d84a6471755` (0 correction(s), reviewer answered in 1 attempt(s))
- slide 2: `5fba460fc648` -> `5fba460fc648` (0 correction(s), reviewer answered in 1 attempt(s))
- slide 3: `0c687e595237` -> `0c687e595237` (0 correction(s), reviewer answered in 1 attempt(s))

## The human review queue

- slide 3, **numeric_mismatch** (blocking): the figure on the slide disagrees with the audited workbook
  - a numeric mismatch may not be corrected automatically: the workbook is the source of truth, so the figure is escalated to a human
  - expected: `$164.2M`, observed: `$168.4M`
