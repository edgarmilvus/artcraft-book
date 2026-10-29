# 3. Exercise 4: Warm-Start Encoder Container — Typed Headless Inference with Strict Null Checks -- solution

The worked solution for Exercise 4: a Node HTTP classifier that loads the
model once per worker, keeps a bounded wait queue, exposes Prometheus metrics,
and shuts down on SIGTERM. The acceptance harness builds the TypeScript, starts
warm, narrow and cold servers, and reopens the HTTP responses.

## What it does

`server.ts` reads `MODEL_PATH`, `WORKER_POOL_SIZE`, `MAX_QUEUE_DEPTH`,
`SHUTDOWN_DRAIN_MS` and `PORT`, then starts a `worker_threads` pool. Each
worker loads the inference shim once and reports `ready` with its
`modelLoadMs`; a request is handed to an idle worker, and only requests that
arrive while every worker is busy enter the wait queue.

The model is deliberately a deterministic stand-in for an ONNX session:
`model.ts` decodes an 8-bit PNG (stdlib zlib), resizes to 224 × 224, and
returns a six-logit category head, RGB palette and confidence. The exercise is
about the typed pool and container contract, not about shipping a model; a
real `onnxruntime-node` session can replace `loadOnnxSession` without touching
`worker.ts`.

The container is a three-stage build. The final stage is
`gcr.io/distroless/nodejs22-debian12`, runs as UID/GID 1000, copies only
runtime content in three `COPY` layers, ships the model, and strips source
maps before the image is assembled.

## The listings

| file | what it is |
| --- | --- |
| `server.ts` | HTTP server, bounded worker pool, readiness, metrics and SIGTERM drain |
| `worker.ts` | worker thread: model load, PNG decode, classify, shutdown |
| `model.ts` | deterministic inference shim and PNG decoder |
| `types.ts` | branded `Confidence`, discriminated worker protocol, no `any` |
| `06_dockerfile.Dockerfile` | three-stage build ending in distroless Node 22 |
| `run_ex4.ts` | acceptance harness: typechecks, builds, starts three servers and verifies the contract |
| `dist/` | emitted JavaScript used by the harness |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_4_warm-start-encoder-container-typed-headless-inference-with-strict-null-checks/files
npx tsx run_ex4.ts
```

The harness runs `tsc` with strict settings, starts the warm server, sends the
five color fixtures, starts a zero-queue server to force a 429, and starts a
cold server to check the cold-start counter. It exits non-zero on the first
failed assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/red.png`, `green.png`, `blue.png`, `dark.png`, `gray.png` | the five classifier fixtures |
| `output/big.png` | an oversized PNG used by the queue test |
| `output/warm.log` | warm-server transcript |
| `output/narrow.log` | zero-queue server transcript |
| `output/cold.log` | cold-start server transcript |
| `output/run_ex4.log` | every acceptance check |
| `output/run-log.json` | check count, failures, warm port and quirks |

## What the harness asserts

- strict `tsc` emits `server.js` and no source maps in the image contract;
- a raw number cannot satisfy `Confidence`; the compile error names the
  branded type;
- the warm server becomes ready, reports a model load and boot time, and
  classifies red as apparel, green as home, blue as electronics, dark as
  unknown and gray as home;
- confidence is a unit number and the palette is the expected RGB triple;
- the metrics endpoint is Prometheus text and exposes the model load time,
  p50/p99 latency, warm-start count and cold-start count;
- `MAX_QUEUE_DEPTH=0` returns `429`, `Retry-After: 1` and a body that names
  the queue while some requests still succeed;
- a cold server increments the cold-start counter while the warm counter
  stays zero;
- SIGTERM exits zero;
- the final image is distroless Node 22, has at most three runtime `COPY`
  layers, copies only runtime content, runs as non-root 1000, ships the model,
  strips source maps, and resolves `worker.js` next to the server module;
- no `any` escapes the source and `Confidence` has a private brand.

## Notes

- The HTTP contract accepts `image/png` and `image/jpeg`, but the shim only
  decodes PNG. A JPEG request reaches the decoder and is refused with an
  explanatory 500; the harness asserts that exact message.
- The queue bound applies only to requests that cannot be handed to an idle
  worker. `MAX_QUEUE_DEPTH=0` therefore means "no waiting at all", not "no
  in-flight work".
- `worker.js` is resolved with `import.meta.url`, not `process.cwd()`; in the
  container the cwd is `/` and a relative `./worker.js` would fail at boot.
- The branded `Confidence` type has no public constructor. `Confidence.from`
  performs the only range check and the only assertion on the brand.
