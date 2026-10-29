// Bounded remediation pass contract
interface RemediationAttempt {
  account: string;
  attempted_action: "round-noop" | "reconciling-item" | "adjust-cell";
  target: { workbook: string; cell: string } | null;
  pre_verdict: ReconVerdict["status"];
  post_verdict: ReconVerdict["status"];
  notes: string;
}

interface ReconciliationReport {
  period: string;
  verdicts: ReconVerdict[];
  lineages: Record<string, LineageRow[]>;      // keyed by account
  remediation_trace: RemediationAttempt[];
  is_final_pass: boolean;
  duration_ms: number;
}
