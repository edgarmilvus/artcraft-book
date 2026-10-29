for (const step of plan) {
  await runCli(
    PHOTOCRAFT_CLI,
    ["--cmd", step.id, "--params", JSON.stringify(step.params)],
    AUTOMATION_TIMEOUT_MS,
    workspace,
  );
}
