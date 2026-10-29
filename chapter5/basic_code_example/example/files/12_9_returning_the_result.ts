      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${output} (800x400 PNG). Upstream result: ${JSON.stringify(
              saved,
            ).slice(0, 400)}`,
          },
        ],
      };
