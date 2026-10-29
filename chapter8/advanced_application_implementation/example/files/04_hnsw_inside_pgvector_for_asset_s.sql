CREATE TABLE vectorforge_assets (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL,
  sku          text NOT NULL,
  svg_path     text NOT NULL,
  png_path     text NOT NULL,
  embedding    vector(512) NOT NULL,
  doc_tree     jsonb NOT NULL,
  created_at   timestamptz DEFAULT now()
);

-- HNSW index over the embedding column, cosine distance.
CREATE INDEX ON vectorforge_assets
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
