// ANTI-PATTERN — do not do this
for (const clip of clipIds) {
  await fc.run("effects.setParam", { clip, effect: "lumetri", param: "wheel_shadows", value: 0.58 });
  await fc.run("effects.setParam", { clip, effect: "lumetri", param: "wheel_shadows_l", value: -0.12 });
}
