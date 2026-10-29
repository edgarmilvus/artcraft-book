src/
  contracts/          # Zod schemas + inferred types
    grading.ts
    loudness.ts
    ducking.ts
  mcp/
    session.ts        # FilmCraft Session wrapper over @modelcontextprotocol/sdk
    discovery.ts      # command_list caching & Lumetri parameter resolution
  services/
    wheel-grader.ts   # three-way shadows/midtones/highlights dispatch
    ducking-engine.ts # dialogue-aware sidechain automation
    loudness-governor.ts # LUFS + true-peak verification
  orchestration/
    gradeloop.ts      # top-level pipeline for a single tenant job
  infra/
    checkpointer.ts   # persistence across MCP reconnects
    errors.ts         # domain error taxonomy
  index.ts
