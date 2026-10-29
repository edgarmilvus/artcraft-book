steps.push({
  id: "effects.setParam",
  params: { ...base, param: channel.colour, value: [push.hue % 1, push.sat], merge: true,
            ...(t !== undefined ? { time: t } : {}) },
});
