/**
 * Type-check every project in the book.
 *
 * Each chapter project carries its own `tsconfig.json`, and the
 * listings in it are the ones the book publishes. Running `tsc` over all
 * of them is the cheapest way to catch a listing that no longer compiles
 * — and it is the check that can run on Linux, where the macOS engine
 * binaries cannot be installed.
 *
 *     node tools/typecheck_all.mjs              # every project
 *     node tools/typecheck_all.mjs chapter20        # one chapter
 *     node tools/typecheck_all.mjs --jobs 4
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

const argv = process.argv.slice(2);
const jobs = Number(argv[argv.indexOf("--jobs") + 1]) || 4;
const filters = argv.filter((a) => !a.startsWith("--") && a !== String(jobs));

/** Every directory under the chapter directories that holds a `tsconfig.json`. */
function projectDirs() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "output" || entry.name === "solutions_and_explanations") continue;
      const path = join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      if (existsSync(join(path, "tsconfig.json"))) {
        found.push(path);
        continue;
      }
      walk(path, depth + 1);
    }
  };
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isDirectory() && /^chapter\d+$/.test(entry.name)) walk(join(ROOT, entry.name), 0);
  }
  return found.sort();
}

if (!existsSync(TSC)) {
  console.error("no tsc — run \"npm install\" first");
  process.exit(1);
}

let targets = projectDirs();
if (filters.length) targets = targets.filter((d) => filters.some((f) => d.includes(f)));
if (!targets.length) {
  console.error("no projects matched");
  process.exit(1);
}

const failures = [];
let index = 0;
let passed = 0;

function worker() {
  while (index < targets.length) {
    const dir = targets[index++];
    const result = spawnSync(TSC, ["--noEmit", "-p", dir], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (result.status === 0) {
      passed += 1;
      process.stdout.write(`ok   ${relative(ROOT, dir)}\n`);
    } else {
      failures.push({ dir, output: `${result.stdout ?? ""}${result.stderr ?? ""}` });
      process.stdout.write(`FAIL ${relative(ROOT, dir)}\n`);
    }
  }
}

await Promise.all(Array.from({ length: jobs }, worker));

console.log(`\n${passed}/${targets.length} projects type-check`);
for (const failure of failures) {
  console.log(`\n--- ${relative(ROOT, failure.dir)} ---\n${failure.output.trim()}`);
}
process.exit(failures.length ? 1 : 0);
