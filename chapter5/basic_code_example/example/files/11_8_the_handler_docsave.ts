      const saved = await pc.callTool({
        name: "doc_save",
        arguments: { path: output, format: "png" },
      });
