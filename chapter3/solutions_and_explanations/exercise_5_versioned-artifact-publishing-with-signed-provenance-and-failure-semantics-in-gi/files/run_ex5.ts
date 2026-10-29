// run_ex5.ts — acceptance harness for Chapter 3, Exercise 5.
//
// Exercises the real publishing flow: DesignCraft collector, both PDF exports,
// PdfCraft PDF/A verification, OpenSSL detached signatures, the release
// manifest, staging → promotion, and every fail-closed path the CI job names:
// modified links, colour-space mismatch, missing fonts, PDF/A failure and an
// existing stable version.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const OUT = resolve(HERE, "..", "output");
const CLIS = resolve(REPO, "tools/craft-cli/bin");
const TSX = resolve(REPO, "node_modules/.bin/tsx");
const TSC = resolve(REPO, "node_modules/.bin/tsc");
const PUBLISH = join(HERE, "05_publish.ts");
const KEY = join(OUT, "keys", "signing.key");
const PUB = join(OUT, "keys", "signing.pub");

const checks: string[] = [];
const failures: string[] = [];
const quirks: string[] = [];
const lines: string[] = [];
const say = (line = ""): void => { lines.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ""): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? " ok " : "FAIL"} ${label.padEnd(62)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const readJson = (file: string): any =>
  JSON.parse(readFileSync(file, "utf8")) as any;
const sha = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const exists = (file: string): boolean => existsSync(file);

// ── PNG fixture helper ───────────────────────────────────────────────────────
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array): number => {
  let c = 0xffffffff;
  for (const x of b) c = (TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typed.copy(out, 4);
  out.writeUInt32BE(crc32(typed), 8 + data.length);
  return out;
};
const writePng = (file: string, width: number, height: number, rgb: readonly [number, number, number]): void => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array()),
  ]));
};

// ── engine/CLI helpers ───────────────────────────────────────────────────────
type Run = { status: number | null; stdout: string; stderr: string };
const env = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: `${CLIS}:${process.env.PATH ?? ""}` });
const runNode = (script: string, args: string[], cwd = HERE): Run => {
  const r = spawnSync("node", [script, ...args], { cwd, encoding: "utf8", timeout: 180_000, env: env() });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const runPublisher = (root: string, args: string[]): Run => {
  const r = spawnSync(TSX, [PUBLISH, "--root", root, "--out", ".", ...args], {
    cwd: HERE, encoding: "utf8", timeout: 300_000, env: env(),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const runOpenssl = (args: string[]): Run => {
  const r = spawnSync("openssl", args, { encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const fixture = (name: string, kind: "clean" | "image" | "missing-font"): string => {
  const root = join(OUT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  const script = kind === "clean" ? "make-clean-layout.mjs"
    : kind === "image" ? "make-layout.mjs" : "make-missing-font.mjs";
  if (kind === "image") writePng(join(root, "assets", "hero.png"), 400, 400, [210, 30, 30]);
  copyFileSync(KEY, join(root, "signing.key"));
  copyFileSync(PUB, join(root, "signing.pub"));
  const result = runNode(join(HERE, script), [root]);
  if (result.status !== 0) throw new Error(`${script}: ${result.stderr.slice(0, 300)}`);
  return root;
};

type ArmorCheck = { armor: string; verified: boolean };
const verifySignature = (file: string, armoredBase64: string): ArmorCheck => {
  const armor = Buffer.from(armoredBase64, "base64").toString("utf8");
  const body = armor.split("\n").filter((line) => !line.startsWith("-----")).join("");
  const der = join(OUT, "keys", `verify-${Math.random().toString(16).slice(2)}.der`);
  writeFileSync(der, Buffer.from(body, "base64"));
  const verified = runOpenssl(["dgst", "-sha256", "-verify", PUB, "-signature", der, file]).status === 0;
  rmSync(der, { force: true });
  return { armor, verified };
};
const verifyAsc = (file: string): boolean => {
  const armor = readFileSync(`${file}.asc`, "utf8");
  const body = armor.split("\n").filter((line) => !line.startsWith("-----")).join("");
  const der = `${file}.check.der`;
  writeFileSync(der, Buffer.from(body, "base64"));
  const ok = runOpenssl(["dgst", "-sha256", "-verify", PUB, "-signature", der, file]).status === 0;
  rmSync(der, { force: true });
  return ok;
};

const pdfText = async (root: string, file: string): Promise<string> => {
  const transport = new StdioClientTransport({
    command: join(CLIS, "pdfcraft-cli"), args: ["mcp", "--root", root], cwd: root, stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "run-ex5", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const unwrap = (res: unknown): unknown => {
      const r = res as { content?: Array<{ type: string; text?: string }> };
      const text = r.content?.find((b) => b.type === "text")?.text;
      try { return text === undefined ? "" : JSON.parse(text) as unknown; } catch { return text ?? ""; }
    };
    const opened = unwrap(await client.callTool({ name: "doc_open", arguments: { path: file } })) as { doc?: number };
    const extracted = unwrap(await client.callTool({ name: "text_extract", arguments: { doc: opened.doc ?? 1 } }));
    return JSON.stringify(extracted);
  } finally {
    await client.close().catch(() => undefined);
  }
};

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "keys"), { recursive: true });
  say("── signing keys ───────────────────────────────────────────────────────");
  const gen = runOpenssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", KEY]);
  const pub = runOpenssl(["pkey", "-in", KEY, "-pubout", "-out", PUB]);
  equal("generate a local signing key", gen.status, 0);
  equal("export the public key", pub.status, 0);
  check("openssl is the local gpg stand-in", exists(KEY) && exists(PUB));

  say("");
  say("── helper compile (CI ships .js under /opt/publish) ───────────────────");
  const build = join(OUT, "helper-build");
  const helpers = ["02_typescript.ts", "04_collect-inputs.ts", "export-pdfs.ts", "pdfa-verify.ts", "build-manifest.ts", "05_publish.ts"];
  const compile = spawnSync(TSC, [
    ...helpers, "--outDir", build, "--rootDir", HERE, "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict",
    "--skipLibCheck", "--types", "node", "--sourceMap", "false",
  ], { cwd: HERE, encoding: "utf8", timeout: 120_000 });
  equal("publication helpers compile", compile.status, 0);
  for (const name of ["04_collect-inputs.js", "export-pdfs.js", "pdfa-verify.js", "build-manifest.js"]) {
    check(`${name} is emitted`, exists(join(build, name)));
  }

  say("");
  say("── positive release: collect → export → PDF/A → sign → promote ─────────");
  const positive = fixture("positive", "clean");
  const posRun = runPublisher(positive, [
    "--layout", "clean-layout.designcraft", "--release", "2026.10.0", "--channel", "beta",
    "--layoutRef", "commit-positive", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(positive, "publisher.log"), posRun.stdout + posRun.stderr);
  equal("positive publisher exits cleanly", posRun.status, 0);
  const pos = readJson(join(positive, "publish-result.json"));
  equal("publish result is published", pos.status, "published");
  equal("published release version", pos.release, "2026.10.0");
  equal("all three signatures verify", pos.signaturesVerified, true);
  equal("staging was removed", pos.stagingRemoved, true);
  check("print PDF exists", exists(join(positive, "catalog-print.pdf")));
  check("web PDF exists", exists(join(positive, "catalog-web.pdf")));
  check("web PDF has a %PDF header", readFileSync(join(positive, "catalog-web.pdf")).subarray(0, 5).toString() === "%PDF-");
  const posReport = readJson(join(positive, "pdfa-verify.json"));
  equal("PDF/A report is compliant", posReport.compliant, true);
  equal("PDF/A level is 2b", posReport.level, "PDF/A-2b");
  const posInputs = readJson(join(positive, "inputs.json"));
  equal("clean layout has no links", (posInputs.links as unknown[]).length, 0);
  equal("clean layout has no colour mismatch", (posInputs.colorMismatches as unknown[]).length, 0);

  const manifestFile = join(positive, "release-manifest.json");
  const manifest = readJson(manifestFile);
  equal("manifest schema version", manifest.schemaVersion, 1);
  equal("manifest release", manifest.releaseVersion, "2026.10.0");
  equal("manifest channel", manifest.channel, "beta");
  equal("manifest layout ref", manifest.layoutRef, "commit-positive");
  check("manifest timestamp is ISO 8601", !Number.isNaN(Date.parse(String(manifest.generatedAt))));
  const provenance = manifest.provenance as Record<string, unknown>;
  equal("manifest records provenance commit", provenance.commitSha, "commit-positive");
  check("manifest names a CI pipeline", String(provenance.ciPipelineId).length > 0);
  const audit = manifest.audit as Record<string, unknown>;
  equal("manifest audit passed", audit.passed, true);
  const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
  equal("manifest carries both PDFs", artifacts.length, 2);
  for (const artifact of artifacts) {
    const name = String(artifact.name);
    const file = join(positive, name);
    check(`${name} exists in staging output`, exists(file));
    equal(`${name} sha256`, artifact.sha256, sha(file));
    equal(`${name} bytes`, artifact.bytes, statSync(file).size);
    equal(`${name} pages`, artifact.pages, 1);
    const signature = verifySignature(file, String(artifact.signatureArmored));
    check(`${name} armor has PGP markers`,
      signature.armor.startsWith("-----BEGIN PGP SIGNATURE-----") && signature.armor.includes("-----END PGP SIGNATURE-----"));
    check(`${name} detached signature verifies`, signature.verified);
    check(`${name} is in the registry`, exists(join(positive, "registry", "catalog", "2026.10.0", name)));
    check(`${name} is signed in the registry`, exists(join(positive, "registry", "catalog", "2026.10.0", `${name}.asc`)));
  }
  const printStandard = artifacts.find((a) => a.name === "catalog-print.pdf")?.pdfStandard;
  const webStandard = artifacts.find((a) => a.name === "catalog-web.pdf")?.pdfStandard;
  equal("print standard is none", printStandard, "none");
  equal("web standard is PDF/A-2b", webStandard, "pdfa2b");
  check("manifest signature verifies", verifyAsc(manifestFile));
  check("registry staging version is gone", !exists(join(positive, "registry", "catalog-staging", "2026.10.0")));
  equal("registry catalog has all six files",
    readdirSync(join(positive, "registry", "catalog", "2026.10.0")).length, 6);
  const text = await pdfText(positive, "catalog-web.pdf");
  check("web PDF carries the catalog text", text.includes("Clean Catalog") && text.includes("Monthly release"), text.slice(0, 120));

  say("");
  say("── blocker: modified link ──────────────────────────────────────────────");
  const modified = fixture("modified", "image");
  writePng(join(modified, "assets", "hero.png"), 400, 400, [30, 200, 30]);
  const modRun = runPublisher(modified, [
    "--layout", "layout.designcraft", "--release", "2026.10.1", "--channel", "beta",
    "--layoutRef", "commit-modified", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(modified, "publisher.log"), modRun.stdout + modRun.stderr);
  equal("modified link blocks the release", modRun.status, 1);
  check("modified-links blocker exists", exists(join(modified, "blockers", "modified-links.json")));
  const modBlock = readJson(join(modified, "blockers", "modified-links.json")) as Array<Record<string, unknown>>;
  equal("blocker records one link", modBlock.length, 1);
  equal("blocker records the modified status", modBlock[0]?.status, "modified");
  equal("modified result reason is audit", readJson(join(modified, "publish-result.json")).reason, "audit");
  check("blocked run exports no PDF", !exists(join(modified, "catalog-print.pdf")));
  check("blocked run creates no catalog version", !exists(join(modified, "registry", "catalog", "2026.10.1")));
  check("blocked run leaves no staging version", !exists(join(modified, "registry", "catalog-staging", "2026.10.1")));

  say("");
  say("── blocker: sRGB image into a CMYK intent ─────────────────────────────");
  const color = fixture("color", "image");
  const colorRun = runPublisher(color, [
    "--layout", "layout.designcraft", "--release", "2026.10.2", "--channel", "beta",
    "--layoutRef", "commit-color", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(color, "publisher.log"), colorRun.stdout + colorRun.stderr);
  equal("colour mismatch blocks the release", colorRun.status, 1);
  check("colour-space blocker exists", exists(join(color, "blockers", "color-space-mismatch.json")));
  const colorBlock = readJson(join(color, "blockers", "color-space-mismatch.json")) as { mismatches: Array<Record<string, unknown>> };
  equal("blocker records one mismatch", colorBlock.mismatches.length, 1);
  equal("mismatch starts in sRGB", colorBlock.mismatches[0]?.from, "sRGB");
  equal("mismatch targets FOGRA39", colorBlock.mismatches[0]?.to, "Coated FOGRA39");
  check("colour-blocked run exports no PDF", !exists(join(color, "catalog-print.pdf")));

  say("");
  say("── blocker: missing font ───────────────────────────────────────────────");
  const missing = fixture("missing", "missing-font");
  const missRun = runPublisher(missing, [
    "--layout", "missing-font.designcraft", "--release", "2026.10.3", "--channel", "beta",
    "--layoutRef", "commit-font", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(missing, "publisher.log"), missRun.stdout + missRun.stderr);
  equal("missing font blocks the release", missRun.status, 1);
  check("missing-fonts blocker exists", exists(join(missing, "blockers", "missing-fonts.json")));
  const missBlock = readJson(join(missing, "blockers", "missing-fonts.json")) as Array<Record<string, unknown>>;
  equal("blocker names one font", missBlock.length, 1);
  equal("blocker records the family", missBlock[0]?.family, "NoSuchFont");
  equal("blocker records missing=true", missBlock[0]?.missing, true);

  say("");
  say("── blocker: PDF/A verification ─────────────────────────────────────────");
  const pdfa = fixture("pdfa", "clean");
  const pdfaRun = runPublisher(pdfa, [
    "--layout", "clean-layout.designcraft", "--release", "2026.10.4", "--channel", "beta",
    "--layoutRef", "commit-pdfa", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
    "--webStandard", "none",
  ]);
  writeFileSync(join(pdfa, "publisher.log"), pdfaRun.stdout + pdfaRun.stderr);
  equal("non-PDF/A web export blocks the release", pdfaRun.status, 1);
  check("PDF/A blocker exists", exists(join(pdfa, "blockers", "pdfa-verify.json")));
  const pdfaBlock = readJson(join(pdfa, "blockers", "pdfa-verify.json"));
  equal("PDF/A blocker is non-compliant", pdfaBlock.compliant, false);
  check("PDF/A blocker lists non-fixable issues",
    (pdfaBlock.issues as Array<Record<string, unknown>>).some((i) => i.fixable === false));
  equal("PDF/A failure reason", readJson(join(pdfa, "publish-result.json")).reason, "pdfa");
  check("PDF/A failure creates no catalog version", !exists(join(pdfa, "registry", "catalog", "2026.10.4")));

  say("");
  say("── stable channel: version exists ──────────────────────────────────────");
  const stable = fixture("stable", "clean");
  const firstStable = runPublisher(stable, [
    "--layout", "clean-layout.designcraft", "--release", "2026.11.0", "--channel", "stable",
    "--layoutRef", "commit-a", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(stable, "publisher-first.log"), firstStable.stdout + firstStable.stderr);
  equal("first stable release publishes", firstStable.status, 0);
  const firstManifest = readJson(join(stable, "registry", "catalog", "2026.11.0", "release-manifest.json"));
  equal("first stable manifest has commit-a", (firstManifest.provenance as Record<string, unknown>).commitSha, "commit-a");
  rmSync(join(stable, "catalog-print.pdf"), { force: true });
  rmSync(join(stable, "catalog-web.pdf"), { force: true });
  const secondStable = runPublisher(stable, [
    "--layout", "clean-layout.designcraft", "--release", "2026.11.0", "--channel", "stable",
    "--layoutRef", "commit-b", "--registry", "registry", "--signingKey", "signing.key", "--publicKey", "signing.pub",
  ]);
  writeFileSync(join(stable, "publisher-second.log"), secondStable.stdout + secondStable.stderr);
  equal("second stable release is refused", secondStable.status, 1);
  check("version-exists blocker exists", exists(join(stable, "blockers", "version-exists.json")));
  equal("stable refusal reason", readJson(join(stable, "publish-result.json")).reason, "version-exists");
  const stillFirst = readJson(join(stable, "registry", "catalog", "2026.11.0", "release-manifest.json"));
  equal("refused release did not overwrite provenance", (stillFirst.provenance as Record<string, unknown>).commitSha, "commit-a");
  check("refused release leaves no staging version", !exists(join(stable, "registry", "catalog-staging", "2026.11.0")));
  check("refused release did not export a new PDF", !exists(join(stable, "catalog-print.pdf")));

  say("");
  say("── CI YAML contracts ───────────────────────────────────────────────────");
  const yaml = readFileSync(join(HERE, "03_yaml.yaml"), "utf8");
  for (const helper of ["collect-inputs.js", "export-pdfs.js", "pdfa-verify.js", "build-manifest.js"]) {
    check(`YAML calls ${helper}`, yaml.includes(`node /opt/publish/${helper}`));
  }
  check("YAML passes --root to every helper", (yaml.match(/--root "\$\(pwd\)"/g) ?? []).length >= 4);
  check("YAML imports the signing key", /gpg --batch --import/.test(yaml));
  check("YAML detach-signs with armor", /gpg --batch --yes --local-user [\s\S]*?--detach-sign --armor/.test(yaml));
  check("YAML verifies every signature", (yaml.match(/gpg --verify/g) ?? []).length >= 2);
  const blockerGate = yaml.indexOf('ls -A "$BLK"');
  const signing = yaml.indexOf("gpg --batch --yes --local-user");
  check("blockers abort before signing", blockerGate > 0 && blockerGate < signing);
  const stagingUpload = yaml.indexOf('upload "catalog-staging/');
  const catalogUpload = yaml.indexOf('upload "catalog/$RELEASE_VERSION/');
  check("staging upload precedes catalog promotion", stagingUpload > 0 && catalogUpload > stagingUpload);
  check("promotion deletes the staging object", /DELETE[\s\S]{0,160}catalog-staging/.test(yaml));
  check("stable versions are checked in the registry", /packages\/generic\/catalog\/\$RELEASE_VERSION/.test(yaml));
  check("artifacts are kept even on failure", /when: always/.test(yaml));
  check("PDF/A report uses the issues field", /\.issues\[\] \| select\(\.fixable == false\)/.test(yaml));
  check("YAML does not read a non-existent rules field", !/\.rules\[\]/.test(yaml));
  check("pipeline exports resolved inputs", /reports:\s*\n\s*dotenv: resolved.env/.test(yaml));
  check("pipeline archives the commit", /git archive --format=tar/.test(yaml));
  check("pipeline fails fast", /set -euo pipefail/.test(yaml));

  say("");
  say("── helper contracts ────────────────────────────────────────────────────");
  const collector = readFileSync(join(HERE, "04_collect-inputs.ts"), "utf8");
  const exporter = readFileSync(join(HERE, "export-pdfs.ts"), "utf8");
  const verifier = readFileSync(join(HERE, "pdfa-verify.ts"), "utf8");
  const builder = readFileSync(join(HERE, "build-manifest.ts"), "utf8");
  const publisher = readFileSync(join(HERE, "05_publish.ts"), "utf8");
  check("collector uses the official MCP SDK", collector.includes("@modelcontextprotocol/sdk"));
  check("collector reads links.list", collector.includes("\"links.list\""));
  check("collector reads font.list", collector.includes("\"font.list\""));
  check("collector flags sRGB image files", /\\\.\(png\|jpe\?g\|webp\)/.test(collector));
  check("exporter writes both PDFs", /catalog-print|--print/.test(exporter) && /catalog-web|--web/.test(exporter));
  check("exporter can mark the web PDF as PDF/A", /standard/.test(exporter) && /a2b/.test(exporter));
  check("verifier opens with PdfCraft", verifier.includes("pdfcraft-cli"));
  check("verifier calls pdfa_verify", verifier.includes("\"pdfa_verify\""));
  check("manifest hashes with sha256", builder.includes("createHash(\"sha256\")"));
  check("manifest embeds armored signatures", builder.includes("signatureArmored"));
  check("publisher signs before the manifest", publisher.indexOf("writeArmor(print") < publisher.indexOf("buildManifest("));
  check("publisher promotes only after signing", publisher.indexOf("buildManifest(") < publisher.indexOf("path.join(staging, name)"));
  check("publisher blocks an existing stable version", /version-exists/.test(publisher));
  check("no hand-rolled JSON-RPC in the helpers", ![collector, exporter, verifier, builder, publisher].some((s) => /\"jsonrpc\"/.test(s)));
  quirks.push("the local signer is OpenSSL with PGP armor; GPG itself is absent on this machine");

  const result = {
    checks: checks.length,
    failures,
    quirks,
    release: "2026.10.0",
    manifestSha256: sha(manifestFile),
    artifacts: artifacts.map((a) => a.name),
  };
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify(result, null, 2) + "\n");
  say("");
  say(`${checks.length} checks, ${failures.length} failing; artefacts in ${OUT}`);
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, "run-log.json"), JSON.stringify({ checks: checks.length, failures, crash: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, "run_ex5.log"), lines.join("\n") + "\n");
}
if (failures.length > 0) process.exitCode = 1;
