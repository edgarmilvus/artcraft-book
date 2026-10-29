export const Confidence = {
    from(value) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
            throw new RangeError(`Confidence must be in [0,1], got ${value}`);
        }
        return value; // the ONLY assertion allowed on the brand
    },
};
//# sourceMappingURL=types.js.map