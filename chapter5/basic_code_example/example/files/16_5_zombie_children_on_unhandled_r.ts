process.on("unhandledRejection", (err) => {
  console.error("[bridge] unhandledRejection:", err);
  process.exit(1);
});
