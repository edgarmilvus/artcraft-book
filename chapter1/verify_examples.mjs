#!/usr/bin/env node
/**
 * verify_examples.mjs — checks that the Chapter 1 basic and advanced examples
 * left real artefacts in their output folders.
 *
 * It deliberately does not re-run the examples: `run_all.sh` does that first.
 * This script reads what is on disk and asserts the properties the chapter
 * promises: the PNGs have the right dimensions, the `.pcraft` files are real
 * layered documents (not renamed PNGs), the model-driven JSON is coherent and
 * the provenance ledger points at files that exist.
 *
 *     node verify_examples.mjs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASIC = join(HERE, "basic_code_example", "example", "output");
const ADVANCED = join(HERE, "advanced_application_implementation", "example", "output");

/**
 * Resolve a path that an artefact recorded.
 *
 * Artefacts carry either a file name relative to their own output directory or
 * the absolute path of the machine that produced them. Try what was recorded,
 * then the output directory it belongs to, then re-root the part from
 * `chapterN/` on at this checkout.
 */
function recorded(value, base = "") {
  if (typeof value !== "string" || value.length === 0) return "__missing__";
  if (existsSync(value)) return value;
  if (base && existsSync(join(base, value))) return join(base, value);
  const suffix = value.match(/(?:^|\/)(chapter\d+\/.*)$/);
  if (suffix) {
    const rerooted = join(HERE, "..", suffix[1]);
    if (existsSync(rerooted)) return rerooted;
  }
  return value;
}

let passed = 0;
const failed = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.log(`FAIL ${label}${detail ? ` ${detail}` : ""}`);
    failed.push(label);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngSize(path) {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.subarray(1, 4).toString("latin1") !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

function zipEntries(path) {
  return execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function zipJson(path, entry) {
  return JSON.parse(execFileSync("unzip", ["-p", path, entry], { encoding: "utf8" }));
}

function isZip(path) {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path).subarray(0, 4);
  return bytes.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

function layerKinds(document) {
  return (document.layers ?? []).map((layer) => layer.content?.kind ?? "unknown");
}

// ── Basic Code Example ─────────────────────────────────────────────────────

const probe = pngSize(join(BASIC, "probe.png"));
check("basic_probe_is_a_png", probe !== null);
check("basic_probe_is_640_by_360", probe?.width === 640 && probe?.height === 360,
  probe ? `${probe.width}x${probe.height}` : "missing");
check("basic_probe_is_not_empty", (probe?.bytes ?? 0) > 2048, `${probe?.bytes ?? 0} bytes`);

const master = pngSize(join(BASIC, "master.png"));
check("basic_master_is_a_png", master !== null);
check("basic_master_is_1920_by_1080", master?.width === 1920 && master?.height === 1080,
  master ? `${master.width}x${master.height}` : "missing");

const studio = join(BASIC, "studio-render.pcraft");
check("basic_studio_document_is_a_zip_container", isZip(studio));
const studioEntries = isZip(studio) ? zipEntries(studio) : [];
check("basic_studio_document_has_a_manifest", studioEntries.includes("manifest.json"));
check("basic_studio_document_has_a_preview", studioEntries.includes("composite/preview.png"));
check("basic_studio_document_has_layer_blobs", studioEntries.some((entry) => entry.startsWith("blobs/")));

const studioManifest = isZip(studio) ? zipJson(studio, "manifest.json") : null;
const studioDoc = studioManifest?.document;
check("basic_studio_manifest_names_the_document", studioDoc?.name === "studio-render.pcraft",
  studioDoc?.name ?? "missing");
check("basic_studio_canvas_has_pixels",
  (studioDoc?.size?.width ?? 0) > 0 && (studioDoc?.size?.height ?? 0) > 0,
  JSON.stringify(studioDoc?.size));
const studioKinds = studioDoc ? layerKinds(studioDoc) : [];
for (const kind of ["raster", "fill", "shape", "text", "adjustment"]) {
  check(`basic_studio_has_a_${kind}_layer`, studioKinds.includes(kind), studioKinds.join(","));
}
const studioText = (studioDoc?.layers ?? [])
  .filter((layer) => layer.content?.kind === "text")
  .map((layer) => layer.content?.text ?? "");
check("basic_studio_keeps_two_addressable_text_runs",
  studioText.length === 2 && studioText.every((text) => text.length > 0),
  studioText.join(" | "));

const plan = existsSync(join(BASIC, "plan.json")) ? readJson(join(BASIC, "plan.json")) : null;
check("basic_plan_is_json", plan !== null);
check("basic_plan_carries_a_validated_canvas",
  Number.isInteger(plan?.plan?.canvas?.width) && Number.isInteger(plan?.plan?.canvas?.height),
  JSON.stringify(plan?.plan?.canvas));
check("basic_plan_carries_a_palette_and_copy",
  /^#[0-9a-f]{6}$/i.test(plan?.plan?.palette?.background ?? "") &&
    (plan?.plan?.headline ?? "").length > 0 &&
    (plan?.plan?.subhead ?? "").length > 0);
check("basic_studio_text_matches_the_plan",
  studioText.includes(plan?.plan?.headline) && studioText.includes(plan?.plan?.subhead),
  `${JSON.stringify([plan?.plan?.headline, plan?.plan?.subhead])} vs ${JSON.stringify(studioText)}`);

const inspect = existsSync(join(BASIC, "inspect.json")) ? readJson(join(BASIC, "inspect.json")) : null;
check("basic_inspect_is_json", inspect !== null);
check("basic_inspect_reports_the_same_canvas_as_the_manifest",
  inspect?.width === studioDoc?.size?.width && inspect?.height === studioDoc?.size?.height,
  `${inspect?.width}x${inspect?.height} vs ${studioDoc?.size?.width}x${studioDoc?.size?.height}`);
const inspectedKinds = (inspect?.layers ?? []).map((layer) => layer.kind);
for (const kind of ["Fill", "Shape", "Type", "Adjustment"]) {
  check(`basic_inspect_has_a_${kind.toLowerCase()}_layer`, inspectedKinds.includes(kind),
    inspectedKinds.join(","));
}

const httpResponse = existsSync(join(BASIC, "http-layered-render.json"))
  ? readJson(join(BASIC, "http-layered-render.json"))
  : null;
check("basic_http_route_reported_success", httpResponse?.ok === true);
check("basic_http_route_named_the_document",
  typeof httpResponse?.document === "string" && httpResponse.document.endsWith(".pcraft"));
check("basic_http_document_exists", existsSync(recorded(httpResponse?.document, BASIC)));
check("basic_http_document_is_a_zip_container", isZip(recorded(httpResponse?.document, BASIC)));
const httpDoc = isZip(recorded(httpResponse?.document, BASIC))
  ? zipJson(recorded(httpResponse.document, BASIC), "manifest.json").document
  : null;
check("basic_http_document_has_the_plan_canvas",
  httpDoc?.size?.width === httpResponse?.plan?.canvas?.width &&
    httpDoc?.size?.height === httpResponse?.plan?.canvas?.height,
  `${httpDoc?.size?.width}x${httpDoc?.size?.height} vs ${httpResponse?.plan?.canvas?.width}x${httpResponse?.plan?.canvas?.height}`);

const basicLog = existsSync(join(BASIC, "run-log.json")) ? readJson(join(BASIC, "run-log.json")) : null;
check("basic_run_log_records_the_pipeline", Array.isArray(basicLog?.log) && basicLog.log.length >= 4);
check("basic_run_log_steps_all_succeeded",
  (basicLog?.log ?? []).every((step) => step.ok === true),
  (basicLog?.log ?? []).filter((step) => step.ok !== true).map((step) => step.step).join(","));

// ── Advanced Application Implementation ────────────────────────────────────

const forge = join(ADVANCED, "forge-real.pcraft");
check("advanced_forge_document_is_a_zip_container", isZip(forge));
const forgeEntries = isZip(forge) ? zipEntries(forge) : [];
check("advanced_forge_document_has_a_manifest", forgeEntries.includes("manifest.json"));
check("advanced_forge_document_has_a_preview", forgeEntries.includes("composite/preview.png"));
const forgeDoc = isZip(forge) ? zipJson(forge, "manifest.json").document : null;
check("advanced_forge_canvas_is_1920_by_1080",
  forgeDoc?.size?.width === 1920 && forgeDoc?.size?.height === 1080,
  JSON.stringify(forgeDoc?.size));
const forgeKinds = forgeDoc ? layerKinds(forgeDoc) : [];
for (const kind of ["raster", "shape", "smart", "adjustment", "group"]) {
  check(`advanced_forge_has_a_${kind}_layer`, forgeKinds.includes(kind), forgeKinds.join(","));
}
check("advanced_forge_keeps_the_warm_layer_comp",
  (forgeDoc?.layer_comps ?? []).some((comp) => comp.name === "warm"));

const forgePng = pngSize(join(ADVANCED, "forge-real.png"));
check("advanced_forge_preview_is_a_png", forgePng !== null);
check("advanced_forge_preview_is_1024_by_576",
  forgePng?.width === 1024 && forgePng?.height === 576,
  forgePng ? `${forgePng.width}x${forgePng.height}` : "missing");

const jobMaster = join(ADVANCED, "LF-42", "out", "LF-42.pcraft");
const ledgerPath = join(ADVANCED, "LF-42", "out", "LF-42.provenance.json");
check("advanced_job_master_is_a_zip_container", isZip(jobMaster));
const jobDoc = isZip(jobMaster) ? zipJson(jobMaster, "manifest.json").document : null;
check("advanced_job_master_is_1920_by_1080",
  jobDoc?.size?.width === 1920 && jobDoc?.size?.height === 1080, JSON.stringify(jobDoc?.size));

const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : null;
check("advanced_ledger_is_json", ledger !== null);
check("advanced_ledger_has_a_recipe_digest", /^[0-9a-f]{64}$/.test(ledger?.recipeDigest ?? ""));
check("advanced_ledger_records_every_phase", (ledger?.phases ?? []).length === 8,
  `${(ledger?.phases ?? []).length} phases`);
check("advanced_ledger_phases_all_succeeded",
  (ledger?.phases ?? []).every((phase) => phase.failed === 0));
check("advanced_ledger_master_exists",
  typeof ledger?.masterPath === "string" && existsSync(recorded(ledger.masterPath, ADVANCED)));
check("advanced_ledger_deliverables_exist",
  (ledger?.deliverables ?? []).length > 0 &&
    ledger.deliverables.every((item) => existsSync(recorded(item.path, ADVANCED))));
check("advanced_ledger_deliverable_is_1920_by_1080",
  pngSize(recorded(ledger?.deliverables?.[0]?.path, ADVANCED))?.width === 1920 &&
    pngSize(recorded(ledger?.deliverables?.[0]?.path, ADVANCED))?.height === 1080);

const heroIn = join(ADVANCED, "LF-42", "in", "hero.png");
check("advanced_job_source_is_present", existsSync(heroIn));
check("advanced_ledger_source_hash_matches_the_bytes",
  ledger?.assets?.[0]?.sha256 === sha256(heroIn),
  `${ledger?.assets?.[0]?.sha256 ?? "none"} vs ${existsSync(heroIn) ? sha256(heroIn) : "missing"}`);
check("advanced_ledger_source_link_is_ok", ledger?.assets?.[0]?.linkStatus === "ok");

const brief = existsSync(join(ADVANCED, "brief.txt")) ? readFileSync(join(ADVANCED, "brief.txt"), "utf8") : "";
const httpBrief = existsSync(join(ADVANCED, "http-brief.txt"))
  ? readFileSync(join(ADVANCED, "http-brief.txt"), "utf8")
  : "";
check("advanced_streamed_brief_is_not_empty", brief.trim().length > 200, `${brief.length} chars`);
check("advanced_http_brief_is_not_empty", httpBrief.trim().length > 200, `${httpBrief.length} chars`);
check("advanced_briefs_agree_on_the_subject",
  /mug|ceramic|stoneware|still life/i.test(brief) && /mug|ceramic|stoneware|still life/i.test(httpBrief));

const advancedLog = existsSync(join(ADVANCED, "run-log.json"))
  ? readJson(join(ADVANCED, "run-log.json"))
  : null;
check("advanced_run_log_records_the_model", typeof advancedLog?.model === "string" && advancedLog.model.length > 0);
check("advanced_run_log_records_the_stream", (advancedLog?.chars ?? 0) > 1000, `${advancedLog?.chars ?? 0} chars`);

// ── Verdict ────────────────────────────────────────────────────────────────

console.log(`\n${passed} assertions passed`);
if (failed.length > 0) {
  for (const label of failed) console.log(`FAILED ${label}`);
  process.exit(1);
}
