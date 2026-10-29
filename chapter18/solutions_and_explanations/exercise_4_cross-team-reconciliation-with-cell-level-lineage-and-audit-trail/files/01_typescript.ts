// Reconciliation fixture
interface ReconAccount {
  account: string;            // "Cash", "ARR", "DeferredRevenue", "TotalDebt", "AvailableLiquidity"
  fpa_cell:  string;          // e.g. "Summary!B12" in the forecast workbook
  acct_cell: string;          // e.g. "Monthly!F4" in the actuals workbook
  treas_cell: string;         // e.g. "CashPosition!C9" in the treasury workbook
  tolerance: string;          // "exact" | "$1" | "pct:0.5"
}

// Prior-period snapshot for salience scoring
interface PriorSnapshot {
  period_prior: string;                // "2026-08"
  cells: Array<{ workbook: string; cell: string; value: number }>;
  flagged_cells: Array<{ workbook: string; cell: string; reason: string }>;
}

// A reconciling item declared in the reconciling-items sheet of the
// workbook that owns it
interface ReconcilingItem {
  account: string;            // the reconciliation account it belongs to
  description: string;        // what the item is
  amount: number;             // the difference it explains
}

// A reconciling item of the prior period, with how often it was used
interface HistoricalItem {
  account: string;
  description: string;
  occurrences: number;        // how many periods it explained
}

// The reconciliation fixture file
interface ReconFixture {
  period: string;                      // "2026-09"
  accounts: ReconAccount[];            // the accounts to reconcile
  sources: Record<string, string>;     // workbook key -> file name
  reconciling_items: {                 // where the declared items live
    workbook: string;
    sheet: string;
  };
}

// Lineage output row
interface LineageRow {
  reconciliation_account: string;
  source_workbook: string;
  source_cell: string;
  named_range: string | null;
  value: number;
  graph_distance: number;
  salience_score: number;
  salience_reasons: string[];  // ["named","changed","flagged","first-hop"]
}

// Verdict
interface ReconVerdict {
  account: string;
  source_values: Record<string, number>;      // keyed by workbook name
  variance: number;                            // max - min
  tolerance: string;
  reconciling_item: string | null;             // description, if applied
  status: "pass" | "pass-with-reconciling-item" | "fail";
  lineage: LineageRow[];
}
