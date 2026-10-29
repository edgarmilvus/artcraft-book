// The shapes the remediation report must have.  The agent produces them from
// the live workbook (sheet.read with formulas), from the engine's own audit
// (formulas.errorChecking) and from the engine's defined names
// (formulas.nameManager).
interface DepNode {
  key: string;               // e.g. "Debt Schedule!D14" or "Debt.BeginningBalance"
  sheet: string;
  is_name: boolean;          // true if this node is a defined name
  formula?: string;          // raw formula text where applicable
  iterative_opt_in?: boolean;// model's iterative calculation flag, if visible
}

interface DepEdge {
  from: string;              // formula cell
  to: string;                // cell read by the formula
}

interface DepGraph {
  nodes: DepNode[];
  edges: DepEdge[];
}

interface CycleReport {
  id: string;                // stable id, e.g. "cycle-001"
  members: string[];         // ordered walk of the cycle
  classification: "true" | "self" | "named-mutual" | "iterative";
}

interface BreakCandidate {
  edge: { from: string; to: string };
  semantic_plausibility: 0 | 1 | 2 | 3 | 4 | 5;
  blast_radius: number;      // count of downstream cells affected
  formula_complexity: number;// 1 (simple ref) .. 5 (nested aggregate)
  total_score: number;       // your weighting; document it
  proposed_formula: string;  // rewritten formula text
  rationale: string;         // one paragraph, human-readable
}

interface RemediationEntry {
  cycle_id: string;
  chosen: BreakCandidate;
  alternatives: BreakCandidate[];
  pre_formula: string;
  post_formula: string;
  verified_acyclic: boolean;
}

interface RemediationReport {
  input_path: string;
  output_path: string;
  input_sha256: string;
  output_sha256: string;
  cycles_found: CycleReport[];
  remediations: RemediationEntry[];
  residual_cycles: string[];        // must be empty for success
  warnings: string[];
  rendered_previews: string[];      // PNG paths
}
