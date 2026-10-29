const colour = `wheel_${band}`;
const luma = `${colour}_l`;
if (!available.has(colour) || !available.has(luma)) throw new Error(...);
