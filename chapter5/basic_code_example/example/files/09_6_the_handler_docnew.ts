    let pc: Client | undefined;

    try {
      pc = await connectPhotoCraft();

      // ── Step 1: create an 800x400 white RGB canvas ──────────────
      await pc.callTool({
        name: "doc_new",
        arguments: {
          width: 800,
          height: 400,
          mode: "rgb",
          depth: 8,
          background: "white",
          name: "HelloBanner",
        },
      });
