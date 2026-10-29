if (t !== undefined) {
  for (const param of [channel.colour, channel.luma]) {
    steps.push({ id: "effects.toggleAnimation", params: { ...base, param } });
  }
}
