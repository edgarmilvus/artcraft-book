      await pc.callTool({
        name: "command_run",
        arguments: {
          id: "type.create",
          params: {
            x: 80,
            y: 220,
            text: greeting,
            font: "Inter-Bold",
            size: 88,
            color: "#111111",
          },
        },
      });
