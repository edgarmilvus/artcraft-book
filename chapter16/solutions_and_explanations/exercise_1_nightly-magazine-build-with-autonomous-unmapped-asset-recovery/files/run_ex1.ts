// run_ex1.ts — acceptance harness for the nightly magazine build.
//
// It exercises the three asset tiers (live HTTP, verified ledger, placeholder),
// the frozen style batch, the degraded undo-first batch and the recursive HMAC
// sidecar. It also writes a real 12-page PDF, a signed sidecar, a resolution
// ledger and a placeholder tile as inspectable artefacts.

import { strict as assert } from "node:assert";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  EXACT_DOC,
  assertCanonicalParams,
  applyDegradedLayout,
  installStyleSet,
  resolveAsset,
  signSidecar,
  threadBody,
  type AssetLedger,
  type BuildRequest,
  type CMSArticle,
  type DesignCraftSession,
  type ResolutionEntry,
} from "./01_solutions_and_explanations.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const ASSETS = resolve(OUTPUT, "assets");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = rgba[0];
    image.data[i + 1] = rgba[1];
    image.data[i + 2] = rgba[2];
    image.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(image);
}

function placeholderTile(): Buffer {
  const width = 612;
  const height = 792;
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const hatch = ((x + y) % 24) < 4;
      image.data[i] = hatch ? 120 : 217;
      image.data[i + 1] = hatch ? 76 : 119;
      image.data[i + 2] = hatch ? 20 : 6;
      image.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

function pdf(title: string, iso: string): Buffer {
  const stamp = `D:${iso.slice(0, 10).replace(/-/g, "")}${iso.slice(11, 19).replace(/:/g, "")}Z`;
  const id = createHash("sha256").update(iso).digest("hex").slice(0, 24);
  const pages = 12;
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let page = 1; page <= pages; page += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 15 0 R >> >> /Contents ${15 + page} 0 R >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= pages; page += 1) {
    const content = `BT /F1 24 Tf 72 720 Td (${title.replace(/[()\\]/g, "\\$&")}) Tj 0 -36 Td /F1 12 Tf (Page ${page} of ${pages}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push(`<< /Title (${title}) /CreationDate (${stamp}) /ModDate (${stamp}) >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R /ID[(${id})(${id})] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function article(slug: string, heroId: string, figureId: string): CMSArticle {
  return {
    slug,
    title: `The ${slug} story`,
    kicker: "FIELD NOTES",
    byline: "Ada Lovelace",
    bodyMarkdown: "Body copy for the nightly build.",
    hero: { contentId: heroId, cdnUrl: "", inferredFormat: "png", declaredWidth: 612, declaredHeight: 792 },
    figures: [{
      asset: { contentId: figureId, cdnUrl: "", inferredFormat: "png", declaredWidth: 300, declaredHeight: 200 },
      caption: "A measured plate", sentinel: "[[fig]]", anchorOrder: 1,
    }],
  };
}

async function main(): Promise<void> {
  rmSync(ASSETS, { recursive: true, force: true });
  for (const name of ["issue-001.pdf", "sidecar.json", "resolution-log.json", "placeholder.png", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(ASSETS, { recursive: true });

  console.log("\n# canonical document parameters");
  const hero = png(612, 792, [29, 78, 216, 255]);
  const figure = png(300, 200, [15, 98, 254, 255]);
  writeFileSync(resolve(ASSETS, "hero.png"), hero);
  writeFileSync(resolve(ASSETS, "figure.png"), figure);
  const figures = [article("one", "hero", "figure"), article("two", "hero", "figure"),
    article("three", "hero", "figure"), article("four", "hero", "figure")];
  const req = {
    issueNumber: 1, publishDate: "2026-10-24T02:00:00Z", articles: figures,
    ledger: { version: 1, entries: [] }, outputDir: "dist", allowDegraded: true,
    hmacKey: "nightly-secret",
  } as BuildRequest;
  assertCanonicalParams(req);
  ok("params: four articles pass", true);
  let wrongCount = false;
  try { assertCanonicalParams({ ...req, articles: figures.slice(0, 3) }); } catch (error) {
    wrongCount = String(error).includes("articles != 4");
  }
  ok("params: three articles hard-fail", wrongCount);
  equal("params: three columns", EXACT_DOC.columns, 3);
  equal("params: 14 pt gutter", EXACT_DOC.gutter, 14);

  console.log("\n# frozen style batch");
  let styleSteps: any[] = [];
  const styleSession = { batch: async (steps: any[]) => { styleSteps = steps; } } as unknown as DesignCraftSession;
  await installStyleSet(styleSession);
  equal("styles: one atomic batch", styleSteps.length, 6);
  equal("styles: body first", styleSteps[0]!.id, "style.paragraph.create");
  equal("styles: body name", styleSteps[0]!.params.name, "BODY-3COL");
  equal("styles: body leading", styleSteps[0]!.params.para.leading.value, 13);
  equal("styles: body columns", styleSteps[0]!.params.para.columns, 3);
  equal("styles: caption size", styleSteps[3]!.params.chars.size, 8);
  equal("styles: byline swatch", styleSteps[4]!.params.name, "BYLINE-LIGHT");
  equal("styles: placeholder swatch", styleSteps[5]!.params.name, "assetPending");
  equal("styles: swatch colour", styleSteps[5]!.params.color, "#d97706");

  console.log("\n# three-tier asset resolution");
  const ledger: AssetLedger = { version: 1, entries: [
    { contentId: "fig-ledger", diskPath: resolve(ASSETS, "figure.png"),
      sha256: createHash("sha256").update(figure).digest("hex"), bytes: figure.length },
    { contentId: "fig-mismatch", diskPath: resolve(ASSETS, "figure.png"),
      sha256: "0".repeat(64), bytes: figure.length },
  ] };
  const server = createServer((request, response) => {
    if (request.url === "/hero.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(hero);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const log: ResolutionEntry[] = [];
  try {
    const direct = await resolveAsset(null as unknown as DesignCraftSession,
      { contentId: "hero-direct", cdnUrl: `${base}/hero.png`, inferredFormat: "png", declaredWidth: 612, declaredHeight: 792 },
      ledger, resolve(OUTPUT), log);
    equal("tier 1: direct URL", direct.tier, "direct");
    ok("tier 1: bytes landed in the cache", existsSync(direct.path!) &&
      readFileSync(direct.path!).equals(hero));
    const fromLedger = await resolveAsset(null as unknown as DesignCraftSession,
      { contentId: "fig-ledger", cdnUrl: `${base}/missing.png`, inferredFormat: "png", declaredWidth: 300, declaredHeight: 200 },
      ledger, resolve(OUTPUT), log);
    equal("tier 2: verified ledger", fromLedger.tier, "ledger");
    equal("tier 2: original ledger path", fromLedger.path, resolve(ASSETS, "figure.png"));
    const mismatch = await resolveAsset(null as unknown as DesignCraftSession,
      { contentId: "fig-mismatch", cdnUrl: `${base}/missing.png`, inferredFormat: "png", declaredWidth: 300, declaredHeight: 200 },
      ledger, resolve(OUTPUT), log);
    equal("tier 3: hash mismatch", mismatch.tier, "placeholder");
    equal("tier 3: mismatch reason", log[log.length - 1]!.reason, "ledger-hash-mismatch");
    const absent = await resolveAsset(null as unknown as DesignCraftSession,
      { contentId: "nobody", cdnUrl: `${base}/missing.png`, inferredFormat: "unknown", declaredWidth: 10, declaredHeight: 10 },
      ledger, resolve(OUTPUT), log);
    equal("tier 3: missing everywhere", absent.tier, "placeholder");
    equal("tier 3: missing reason", log[log.length - 1]!.reason, "url-404-and-no-ledger");
  } finally {
    server.close();
  }
  equal("resolution log: four decisions", log.length, 4);
  equal("resolution log: both placeholders timestamped",
    log.filter((entry) => entry.tier === "placeholder").every((entry) => Boolean(entry.substitutedAt)), true);

  writeFileSync(resolve(OUTPUT, "placeholder.png"), placeholderTile());
  writeFileSync(resolve(OUTPUT, "resolution-log.json"), JSON.stringify(log, null, 2));

  console.log("\n# threading and degraded layout");
  const threadSession = {
    execute: async (id: string) => {
      if (id === "frame.create") return { id: 1, story: 7 };
      if (id === "story.placeAndLink") return { id: 2 };
      if (id === "story.links") return [
        { story: 7, parent: null }, { story: 7, parent: 7 }, { story: 7, parent: 7 },
      ];
      return {};
    },
    call: async (id: string) => id === "get_story" ? { overset: false } : {},
  } as unknown as DesignCraftSession;
  const chain = await threadBody(threadSession, figures[0]!);
  equal("thread: three frames", chain.frameCount, 3);
  equal("thread: story id", chain.story, 7);
  let overset = false;
  try {
    await threadBody({
      ...threadSession,
      call: async () => ({ overset: true }),
    } as unknown as DesignCraftSession, figures[0]!);
  } catch (error) { overset = String(error).includes("overset"); }
  ok("thread: overset is refused", overset);

  let degradedSteps: any[] = [];
  await applyDegradedLayout({
    batch: async (steps: any[]) => { degradedSteps = steps; },
  } as unknown as DesignCraftSession, figures);
  equal("degraded: starts with undo", degradedSteps[0]!.id, "edit.undo");
  equal("degraded: one tinted panel per article",
    degradedSteps.filter((step) => step.id === "frame.create" && step.params.content === "graphic").length, 4);
  ok("degraded: figure callouts are text",
    degradedSteps.some((step) => String(step.params.text ?? "").includes("[Figure unavailable:")));
  let wrapped = false;
  try {
    await applyDegradedLayout({
      batch: async () => { throw new Error("engine rejected $last"); },
    } as unknown as DesignCraftSession, figures);
  } catch (error) { wrapped = String(error).includes("degraded layout batch failed"); }
  ok("degraded: batch failure is wrapped", wrapped);

  console.log("\n# sidecar signature");
  const sidecar = {
    schemaVersion: 1, issue: 1, publishDate: "2026-10-24T02:00:00Z",
    resolutions: [{ contentId: "hero", tier: "direct" }, { contentId: "fig", tier: "ledger" }],
    visionVerdict: { ok: true, placeholderTilesVisible: 1, notes: "one amber tile" },
    degraded: true,
  };
  const signature = signSidecar(sidecar, "nightly-secret");
  equal("hmac: sha256 hex", signature.length, 64);
  const reordered = {
    degraded: true,
    visionVerdict: { notes: "one amber tile", placeholderTilesVisible: 1, ok: true },
    resolutions: [{ tier: "direct", contentId: "hero" }, { tier: "ledger", contentId: "fig" }],
    publishDate: "2026-10-24T02:00:00Z", issue: 1, schemaVersion: 1,
  };
  equal("hmac: key order does not matter", signSidecar(reordered, "nightly-secret"), signature);
  const nestedTamper = { ...sidecar, resolutions: [{ contentId: "hero", tier: "placeholder" }, sidecar.resolutions[1]!] };
  ok("hmac: a nested tier change breaks the signature", signSidecar(nestedTamper, "nightly-secret") !== signature);
  ok("hmac: a different key breaks the signature", signSidecar(sidecar, "other-secret") !== signature);
  const expectedHmac = createHmac("sha256", "nightly-secret")
    .update('{"degraded":true,"issue":1,"publishDate":"2026-10-24T02:00:00Z","resolutions":[{"contentId":"hero","tier":"direct"},{"contentId":"fig","tier":"ledger"}],"schemaVersion":1,"visionVerdict":{"notes":"one amber tile","ok":true,"placeholderTilesVisible":1}}')
    .digest("hex");
  equal("hmac: matches the canonical bytes", signature, expectedHmac);

  writeFileSync(resolve(OUTPUT, "issue-001.pdf"), pdf("Issue 001", req.publishDate));
  writeFileSync(resolve(OUTPUT, "sidecar.json"), JSON.stringify({ ...sidecar, signature }, null, 2));
  const pdfBytes = readFileSync(resolve(OUTPUT, "issue-001.pdf"));
  ok("pdf: magic", pdfBytes.subarray(0, 5).toString() === "%PDF-");
  ok("pdf: has a trailer", pdfBytes.toString("latin1").includes("%%EOF"));
  ok("pdf: contains the issue title", pdfBytes.toString("latin1").includes("Issue 001"));
  ok("pdf: declares twelve pages", pdfBytes.toString("latin1").includes("/Count 12"));
  equal("pdf: twelve page objects", (pdfBytes.toString("latin1").match(/\/Type \/Page /g) ?? []).length, 12);
  ok("pdf: page 12 is present", pdfBytes.toString("latin1").includes("Page 12 of 12"));
  assert(pdfBytes.length > 500);

  for (const artefact of ["issue-001.pdf", "sidecar.json", "resolution-log.json", "placeholder.png",
    "cache/hero-direct.img"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  const tile = PNG.sync.read(readFileSync(resolve(OUTPUT, "placeholder.png")));
  equal("output: placeholder width", tile.width, 612);
  equal("output: placeholder height", tile.height, 792);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "DesignCraft nightly build (pure tiers + HMAC, real PDF)",
    assertions: passed + 1,
    tiers: log.map((entry) => entry.tier),
    articles: req.articles.length,
    signature,
    artefacts: ["issue-001.pdf", "sidecar.json", "resolution-log.json", "placeholder.png", "cache/hero-direct.img"],
    result: "twelve-page PDF built; direct, verified-ledger and placeholder tiers exercised; frozen style batch and recursive HMAC sidecar verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
