// src/server.ts — HTTP + worker pool orchestrator.
import { createServer } from "node:http";
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
function readConfig() {
    const e = process.env;
    // exactOptionalPropertyTypes requires explicit narrowing on env reads.
    const modelPath = e["MODEL_PATH"];
    if (modelPath === undefined)
        throw new Error("MODEL_PATH is required");
    return {
        modelPath,
        poolSize: Number(e["WORKER_POOL_SIZE"] ?? "2"),
        maxQueueDepth: Number(e["MAX_QUEUE_DEPTH"] ?? "64"),
        drainMs: Number(e["SHUTDOWN_DRAIN_MS"] ?? "5000"),
        port: Number(e["PORT"] ?? "8080"),
    };
}
class Pool {
    cfg;
    workers = [];
    rrIdx = 0;
    perWorker = new Map();
    queue = [];
    busy = new Map();
    inflight = 0;
    constructor(cfg) {
        this.cfg = cfg;
    }
    async start() {
        const readyPromises = [];
        for (let i = 0; i < this.cfg.poolSize; i++) {
            // Resolve the worker next to *this module*, not against the process
            // cwd: in the container the cwd is `/`, and `./worker.js` would be a
            // MODULE_NOT_FOUND at boot.
            const w = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js"), {
                workerData: { modelPath: this.cfg.modelPath, shutdownDrainMs: this.cfg.drainMs },
            });
            this.workers.push(w);
            const state = { pending: new Map(), nextId: 1, ready: false, loadMs: 0 };
            this.perWorker.set(w, state);
            this.busy.set(w, false);
            w.on("message", (m) => {
                if (m.kind === "ready") {
                    state.ready = true;
                    state.loadMs = m.modelLoadMs;
                    this.busy.set(w, false);
                    this.dispatch();
                    return;
                }
                if (m.kind === "result") {
                    const p = state.pending.get(m.id);
                    if (p) {
                        state.pending.delete(m.id);
                        this.inflight--;
                        p.resolve(m.classification);
                    }
                    this.busy.set(w, false);
                    this.dispatch();
                    return;
                }
                if (m.kind === "error") {
                    const p = state.pending.get(m.id);
                    if (p) {
                        state.pending.delete(m.id);
                        this.inflight--;
                        p.reject(new Error(m.message));
                    }
                    this.busy.set(w, false);
                    this.dispatch();
                    return;
                }
                if (m.kind === "shutdown") { /* drain confirmed */ }
            });
            readyPromises.push(new Promise((res) => {
                const t = setInterval(() => { if (state.ready) {
                    clearInterval(t);
                    res();
                } }, 5);
            }));
        }
        await Promise.all(readyPromises);
    }
    stats() {
        const loads = [...this.perWorker.values()].map(s => s.loadMs);
        return { loadMs: loads.length > 0 ? Math.max(...loads) : 0 };
    }
    queueDepth() { return this.queue.length; }
    inflightCount() { return this.inflight; }
    isReady() { return this.workers.some((w) => this.perWorker.get(w)?.ready === true); }
    /** Hand queued work to ready, idle workers. */
    dispatch() {
        while (this.queue.length > 0) {
            const w = this.workers.find((candidate) => this.perWorker.get(candidate)?.ready === true && this.busy.get(candidate) !== true);
            if (w === undefined)
                return;
            const task = this.queue.shift();
            const st = this.perWorker.get(w);
            const id = st.nextId++;
            st.pending.set(id, { resolve: task.resolve, reject: task.reject, enqueuedAt: Date.now() });
            this.busy.set(w, true);
            this.inflight++;
            const msg = { kind: "classify", id, jpeg: task.jpeg };
            // Transfer the ArrayBuffer so we don't copy 500 KB per request.
            w.postMessage(msg, [task.jpeg]);
        }
    }
    classify(jpeg) {
        // A task is queued only when every ready worker is busy. The bound is on
        // that wait queue; `MAX_QUEUE_DEPTH=0` means "no waiting at all".
        const idle = this.workers.some((w) => this.perWorker.get(w)?.ready === true && this.busy.get(w) !== true);
        if (!idle && this.queue.length >= this.cfg.maxQueueDepth) {
            return Promise.reject(Object.assign(new Error("queue full"), { code: "QUEUE_FULL" }));
        }
        if (!this.isReady()) {
            return Promise.reject(Object.assign(new Error("no ready worker"), { code: "NOT_READY" }));
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ jpeg, resolve, reject });
            this.dispatch();
        });
    }
    async shutdown() {
        await Promise.all(this.workers.map(w => new Promise((res) => {
            const timer = setTimeout(() => { w.terminate(); res(); }, this.cfg.drainMs + 100);
            w.once("exit", () => { clearTimeout(timer); res(); });
            const shutdown = { kind: "shutdown" };
            w.postMessage(shutdown);
        })));
    }
}
// Prometheus counters
const metrics = {
    warmStartHits: 0, coldStartCount: 0,
    inferenceLatencyMs: [],
};
function pct(xs, p) {
    if (xs.length === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
    return s[i] ?? 0;
}
async function main() {
    const cfg = readConfig();
    const pool = new Pool(cfg);
    const bootStart = Date.now();
    await pool.start();
    const bootMs = Date.now() - bootStart;
    if (process.env["WARM_START"] === "true")
        metrics.warmStartHits++;
    else
        metrics.coldStartCount++;
    const server = createServer(async (req, res) => {
        const url = req.url ?? "/";
        if (req.method === "GET" && url === "/readyz") {
            if (pool.isReady() && metrics.warmStartHits + metrics.coldStartCount > 0) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ status: "ready", modelLoadMs: pool.stats().loadMs, bootMs }));
            }
            else {
                res.writeHead(503);
                res.end(JSON.stringify({ status: "warming" }));
            }
            return;
        }
        if (req.method === "GET" && url === "/metrics") {
            const body = `# TYPE warmStartHits counter\nwarmStartHits ${metrics.warmStartHits}\n` +
                `# TYPE coldStartCount counter\ncoldStartCount ${metrics.coldStartCount}\n` +
                `# TYPE inferenceLatencyP50Ms gauge\ninferenceLatencyP50Ms ${pct(metrics.inferenceLatencyMs, 50)}\n` +
                `# TYPE inferenceLatencyP99Ms gauge\ninferenceLatencyP99Ms ${pct(metrics.inferenceLatencyMs, 99)}\n` +
                `# TYPE modelLoadMs gauge\nmodelLoadMs ${pool.stats().loadMs}\n`;
            res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
            res.end(body);
            return;
        }
        if (req.method === "POST" && url === "/classify") {
            const ct = req.headers["content-type"];
            // The shim decodes PNG; the wire contract accepts either.
            if (ct !== "image/jpeg" && ct !== "image/png") {
                res.writeHead(415);
                res.end();
                return;
            }
            const chunks = [];
            for await (const c of req)
                chunks.push(c);
            const buf = Buffer.concat(chunks);
            // Copy the exact-length ArrayBuffer (Node Buffer slices share memory).
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            const t0 = Date.now();
            try {
                const cls = await pool.classify(ab);
                metrics.inferenceLatencyMs.push(Date.now() - t0);
                if (metrics.inferenceLatencyMs.length > 4096)
                    metrics.inferenceLatencyMs.shift();
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(cls));
            }
            catch (err) {
                const e = err;
                if (e.code === "QUEUE_FULL") {
                    res.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "queue full" }));
                }
                else {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: e.message }));
                }
            }
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(cfg.port);
    const shutdown = async (signal) => {
        server.close();
        await pool.shutdown();
        process.exit(signal === "SIGTERM" ? 0 : 130);
    };
    process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
    process.on("SIGINT", () => { void shutdown("SIGINT"); });
}
void main();
//# sourceMappingURL=server.js.map