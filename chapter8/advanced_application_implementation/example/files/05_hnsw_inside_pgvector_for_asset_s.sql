SELECT id, svg_path, 1 - (embedding <=> $1) AS similarity
FROM vectorforge_assets
WHERE tenant_id = $2
ORDER BY embedding <=> $1
LIMIT 3;
