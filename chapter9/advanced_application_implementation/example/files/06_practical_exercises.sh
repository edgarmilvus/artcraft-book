# Entry point your harness must expose:
lightcraft-cli mcp \
    --library /work/catalog \
    --automation-write-root /work/catalog \
    --postgres-dsn "postgres://wf:wf@pgvector:5432/wf"
