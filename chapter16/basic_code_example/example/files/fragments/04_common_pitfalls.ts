// DON'T: twelve concurrent mutations of the same document.
await Promise.all(
  frames.map(f => client.callTool({
    name: "execute",
    arguments: { command: "story.placeAndLink", params: { story, ...f } },
  })),
);
