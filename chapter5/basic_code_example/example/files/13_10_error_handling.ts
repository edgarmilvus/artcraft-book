    } catch (err) {
      // Never let a child failure escape as an unhandled rejection —
      // MCP expects a well-formed CallToolResult with `isError`.
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `hello_world_banner failed: ${message}`,
          },
        ],
      };
