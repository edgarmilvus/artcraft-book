// agent/claude_tools.ts
export interface LightCraftTool {
  name: string;
  description: string;
  input_schema: object;
}

export const LIGHTCRAFT_AGENT_TOOLS: LightCraftTool[] = [
  {
    name: "run_lightcraft",
    description:
      "Run any LightCraft command by id. Returns the command result JSON.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        params: { type: "object" },
      },
      required: ["command"],
    },
  },
  {
    name: "query_vector_store",
    description:
      "Run a parameterized SQL query against the pgvector store. " +
      "Only SELECTs against photo_faces, face_embeddings, and burst_clusters are permitted.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array" },
      },
      required: ["sql"],
    },
  },
  {
    name: "knn_cluster",
    description:
      "Given a photo_id, return the k nearest photos by combined embedding distance " +
      "with a time-window constraint in seconds.",
    input_schema: {
      type: "object",
      properties: {
        photo_id: { type: "integer" },
        k: { type: "integer", default: 12 },
        time_window_sec: { type: "integer", default: 8 },
      },
      required: ["photo_id"],
    },
  },
  {
    name: "evaluate_hero",
    description:
      "Compute the hero score S for a photo using sharpness, eye-open probability, " +
      "horizon score, and composition balance. Returns the score breakdown.",
    input_schema: {
      type: "object",
      properties: { photo_id: { type: "integer" } },
      required: ["photo_id"],
    },
  },
  {
    name: "commit_decision",
    description:
      "Atomically commit picks/rejects/neutrals for a cluster. " +
      "Wraps photo.flag (pick / reject / none) behind a single batch.",
    input_schema: {
      type: "object",
      properties: {
        hero_id: { type: "integer" },
        reject_ids: { type: "array", items: { type: "integer" } },
        neutral_ids: { type: "array", items: { type: "integer" } },
        label: { type: "string" },
      },
      required: ["hero_id", "reject_ids", "neutral_ids"],
    },
  },
];
