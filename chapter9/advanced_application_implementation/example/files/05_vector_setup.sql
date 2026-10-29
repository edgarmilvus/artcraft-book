-- schema/vector_setup.sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS photo_faces (
    photo_id     BIGINT  NOT NULL,
    face_index   INT     NOT NULL,
    embedding    vector(512) NOT NULL,
    bbox         JSONB   NOT NULL,
    named_as     TEXT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (photo_id, face_index)
);

CREATE INDEX IF NOT EXISTS photo_faces_hnsw
    ON photo_faces
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE OR REPLACE FUNCTION knn_faces(
    query_vec vector(512),
    k INT DEFAULT 20
) RETURNS TABLE (photo_id BIGINT, face_index INT, distance FLOAT) AS $$
    SELECT photo_id, face_index, embedding <=> query_vec AS distance
    FROM photo_faces
    ORDER BY embedding <=> query_vec
    LIMIT k;
$$ LANGUAGE SQL STABLE;
