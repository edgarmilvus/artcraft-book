async batch(steps: FilmCraftStep[], stopOnError = true): Promise<BatchEnvelope> {
  return (await this.call("command_batch", { steps, stop_on_error: stopOnError })) as BatchEnvelope;
}
