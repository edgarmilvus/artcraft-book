server.registerTool(
  "hello_world_banner",
  {
    title: "Hello World Banner",
    description:
      "Creates a 800x400 PNG banner with a single line of text and saves it under the bridge's write root.",
    inputSchema: {
      greeting: z
        .string()
        .min(1)
        .max(80)
        .default("Hello, World!")
        .describe("The line of text to draw on the banner."),
      output: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\.png$/, "must be a bare *.png filename")
        .default("hello.png")
        .describe("Filename (relative to the write root) of the PNG to write."),
    },
  },
