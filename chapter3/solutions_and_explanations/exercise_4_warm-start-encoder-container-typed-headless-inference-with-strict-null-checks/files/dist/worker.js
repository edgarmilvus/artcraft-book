// src/worker.ts — the ONNX session lives HERE, in a dedicated thread.
// WHY worker_threads (not an in-process session):
//   (1) An ONNX session.run() on a 224x224 float tensor monopolises the libuv
//       thread for 30–90 ms. Under in-process scheduling this blocks the HTTP
//       accept loop and inflates p99 latency for *every* concurrent request.
//   (2) A hung/corrupt tensor in native code can't be interrupted from JS; only
//       worker.terminate() reaches into the thread and severs the native stack.
//   (3) Pool isolation lets us run 2 sessions with independent scratch buffers
//       so a single runaway inference cannot OOM the whole pod.
import { parentPort, workerData } from "node:worker_threads";
// Provided by the harness shim (`src/model.ts`): the book declares these as
// "compile-time injected, not shown". Swap that file for a real
// `onnxruntime-node` session and nothing here changes.
import { decodeJpegToTensor, loadOnnxSession } from "./model.js";
const port = parentPort;
if (!port)
    throw new Error("worker must run under worker_threads");
// Runtime validation of the inbound image (zod-equivalent, hand-written to keep
// the final image small).
function assertJpeg(buf) {
    // Accepts PNG as well: the shim ships a PNG decoder (see src/model.ts).
    if (buf.byteLength < 8)
        throw new Error("image too short");
    const u8 = new Uint8Array(buf, 0, 8);
    const png = u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
    const jpeg = u8[0] === 0xFF && u8[1] === 0xD8;
    if (!png && !jpeg)
        throw new Error("not a PNG or JPEG (bad signature)");
}
const confidence = (v) => {
    if (!Number.isFinite(v) || v < 0 || v > 1)
        throw new RangeError("confidence out of range");
    return v;
};
async function boot() {
    const t0 = Date.now();
    const sess = await loadOnnxSession(workerData.modelPath);
    // Warm-up dummy inference: required before /readyz flips to ready.
    await sess.run(new Float32Array(1 * 3 * 224 * 224), [1, 3, 224, 224]);
    const modelLoadMs = Date.now() - t0;
    port.postMessage({ kind: "ready", modelLoadMs });
    let inFlight = 0;
    const drainDeadline = { at: 0 };
    port.on("message", async (req) => {
        if (req.kind === "shutdown") {
            // Drain: wait up to SHUTDOWN_DRAIN_MS for in-flight to reach 0.
            const deadline = Date.now() + workerData.shutdownDrainMs;
            while (inFlight > 0 && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 10));
            }
            await sess.dispose();
            port.postMessage({ kind: "shutdown", drained: inFlight });
            process.exit(inFlight === 0 ? 0 : 130);
        }
        if (req.kind === "classify") {
            inFlight++;
            try {
                assertJpeg(req.jpeg);
                const tensor = await decodeJpegToTensor(req.jpeg);
                const out = await sess.run(tensor, [1, 3, 224, 224]);
                // Output layout: [categoryLogit x 6, paletteR, paletteG, paletteB, confidence]
                const catIdx = argmax6(out, 0);
                const cats = ["apparel", "electronics", "home", "beauty", "food", "unknown"];
                const cat = cats[catIdx] ?? "unknown";
                const r = clamp255(out[6] ?? 0);
                const g = clamp255(out[7] ?? 0);
                const b = clamp255(out[8] ?? 0);
                const cls = {
                    category: cat,
                    dominantPalette: [r, g, b],
                    confidence: confidence(out[9] ?? 0),
                };
                port.postMessage({ kind: "result", id: req.id, classification: cls });
            }
            catch (err) {
                port.postMessage({ kind: "error", id: req.id, message: err.message });
            }
            finally {
                inFlight--;
            }
        }
    });
}
function argmax6(a, off) {
    let bi = 0, bv = a[off] ?? -Infinity;
    for (let i = 1; i < 6; i++) {
        const v = a[off + i] ?? -Infinity;
        if (v > bv) {
            bv = v;
            bi = i;
        }
    }
    return bi;
}
function clamp255(v) {
    const r = Math.max(0, Math.min(255, Math.round(v)));
    return r;
}
void boot();
//# sourceMappingURL=worker.js.map