-- Enable the pgvector extension once per database.
create extension if not exists vector;

-- One row per historical hero banner the studio has ever produced.
create table if not exists brand_assets (
  id          uuid primary key default gen_random_uuid(),
  brief       text not null,
  headline    text not null,
  cta         text not null,
  palette     jsonb not null default '[]'::jsonb,
  embedding   vector(1536) not null,
  created_at  timestamptz not null default now()
);

-- An HNSW index keeps cosine-distance search sub-linear even at scale.
create index if not exists brand_assets_embedding_idx
  on brand_assets
  using hnsw (embedding vector_cosine_ops);

-- The RPC the studio calls from TypeScript.
create or replace function match_brand_assets (
  query_embedding vector(1536),
  match_threshold float,
  match_count     int
)
returns table (
  id          uuid,
  brief       text,
  headline    text,
  cta         text,
  palette     jsonb,
  similarity  float
)
language sql
stable
as $$
  select
    ba.id,
    ba.brief,
    ba.headline,
    ba.cta,
    ba.palette,
    1 - (ba.embedding <=> query_embedding) as similarity
  from brand_assets ba
  where 1 - (ba.embedding <=> query_embedding) > match_threshold
  order by ba.embedding <=> query_embedding
  limit match_count;
$$;
