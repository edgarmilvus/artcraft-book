for (const step of plan) {
  argv.push("--cmd", step.id, "--params", JSON.stringify(step.params));  // OK
}
