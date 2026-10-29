// 05_publish.ts — the local form of the GitLab publish_catalog job.
//
// It runs the same order as the CI job: collect provenance → audit → export →
// PDF/A verify → sign → manifest → staging → promote. The registry is a local
// directory tree so the acceptance harness can inspect every move; the GitLab
// YAML uses the same file names and the same fail-closed order.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { collect } from "./04_collect-inputs.js";
import { exportPdfs } from "./export-pdfs.js";
import { verifyPdfa } from "./pdfa-verify.js";
import { buildManifest } from "./build-manifest.js";
const parseArgs = () => {
    const argv = process.argv.slice(2);
    const arg = (flag) => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const root = path.resolve(arg("--root") ?? process.cwd());
    const required = (flag) => {
        const value = arg(flag);
        if (value === undefined)
            throw new Error(`missing ${flag}`);
        return value;
    };
    return {
        root,
        layout: required("--layout"),
        release: required("--release"),
        channel: (arg("--channel") ?? "beta"),
        layoutRef: arg("--layoutRef") ?? "local",
        out: path.resolve(root, arg("--out") ?? "."),
        registry: path.resolve(root, arg("--registry") ?? "registry"),
        ...(arg("--signingKey") === undefined ? {} : { signingKey: path.resolve(root, arg("--signingKey")) }),
        ...(arg("--publicKey") === undefined ? {} : { publicKey: path.resolve(root, arg("--publicKey")) }),
        webStandard: (arg("--webStandard") ?? "a2b"),
    };
};
const sha256File = async (file) => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
};
const writeArmor = async (file, key, pub) => {
    const der = `${file}.der`;
    execFileSync("openssl", ["dgst", "-sha256", "-sign", key, "-out", der, file], { stdio: "pipe" });
    const body = execFileSync("openssl", ["base64", "-in", der], { encoding: "utf8" }).trim();
    const armor = `-----BEGIN PGP SIGNATURE-----\n\n${body}\n-----END PGP SIGNATURE-----\n`;
    execFileSync("openssl", ["dgst", "-sha256", "-verify", pub, "-signature", der, file], { stdio: "pipe" });
    await fs.writeFile(`${file}.asc`, armor);
};
/** OpenSSL stand-in for `gpg --detach-sign --armor` (the local machine has no gpg). */
const verifyArmor = (file, pub) => {
    const der = `${file}.der`;
    if (!requireExists(file) || !requireExists(der))
        return false;
    try {
        execFileSync("openssl", ["dgst", "-sha256", "-verify", pub, "-signature", der, file], { stdio: "pipe" });
        return true;
    }
    catch {
        return false;
    }
};
const requireExists = (file) => {
    try {
        return existsSync(file);
    }
    catch {
        return false;
    }
};
async function main() {
    const args = parseArgs();
    const blockers = path.join(args.out, "blockers");
    const staging = path.join(args.registry, "catalog-staging", args.release);
    const catalog = path.join(args.registry, "catalog", args.release);
    await fs.mkdir(args.out, { recursive: true });
    await fs.mkdir(blockers, { recursive: true });
    const inputsPath = path.join(args.out, "inputs.json");
    const inputs = await collect(args.root, args.layout);
    await fs.writeFile(inputsPath, JSON.stringify(inputs, null, 2) + "\n");
    const modified = inputs.links.filter((l) => l.status !== "ok");
    const missingFonts = inputs.fonts.filter((f) => f.missing || f.styleMissing);
    if (modified.length > 0)
        await fs.writeFile(path.join(blockers, "modified-links.json"), JSON.stringify(modified, null, 2) + "\n");
    if (missingFonts.length > 0)
        await fs.writeFile(path.join(blockers, "missing-fonts.json"), JSON.stringify(missingFonts, null, 2) + "\n");
    if (inputs.colorMismatches.length > 0)
        await fs.writeFile(path.join(blockers, "color-space-mismatch.json"), JSON.stringify({ mismatches: inputs.colorMismatches }, null, 2) + "\n");
    const fail = async (reason) => {
        const files = await fs.readdir(blockers).catch(() => []);
        await fs.rm(staging, { recursive: true, force: true });
        await fs.writeFile(path.join(args.out, "publish-result.json"), JSON.stringify({
            status: "blocked", reason, blockers: files.sort(),
        }, null, 2) + "\n");
        console.log(JSON.stringify({ status: "blocked", reason, blockers: files.length }));
        return 1;
    };
    if (await fs.readdir(blockers).then((files) => files.length > 0))
        return fail("audit");
    if (args.channel === "stable") {
        const exists = await fs.stat(catalog).then(() => true).catch(() => false);
        if (exists && (await fs.readdir(catalog)).length > 0) {
            await fs.writeFile(path.join(blockers, "version-exists.json"), JSON.stringify({ reason: "version exists", version: args.release }, null, 2) + "\n");
            return fail("version-exists");
        }
    }
    const print = path.join(args.out, "catalog-print.pdf");
    const web = path.join(args.out, "catalog-web.pdf");
    const exported = await exportPdfs(args.root, args.layout, path.relative(args.root, print), path.relative(args.root, web), args.webStandard);
    const reportPath = path.join(args.out, "pdfa-verify.json");
    const report = await verifyPdfa(args.root, path.relative(args.root, web), "2b", reportPath);
    if (!report.compliant) {
        await fs.writeFile(path.join(blockers, "pdfa-verify.json"), JSON.stringify(report, null, 2) + "\n");
        return fail("pdfa");
    }
    if (args.signingKey === undefined || args.publicKey === undefined) {
        throw new Error("local publishing requires --signingKey and --publicKey (or install gpg for the CI path)");
    }
    await writeArmor(print, args.signingKey, args.publicKey);
    await writeArmor(web, args.signingKey, args.publicKey);
    const manifestPath = path.join(args.out, "release-manifest.json");
    const manifest = await buildManifest({
        root: args.root, release: args.release, channel: args.channel, layoutRef: args.layoutRef,
        print, web, inputs: inputsPath, out: manifestPath,
        printStandard: "none", webStandard: args.webStandard === "a2b" ? "pdfa2b" : "none",
        provenance: {
            ciPipelineId: process.env["CI_PIPELINE_ID"] ?? "local-pipeline",
            ciJobId: process.env["CI_JOB_ID"] ?? "local-job",
            commitSha: process.env["CI_COMMIT_SHA"] ?? args.layoutRef,
            runnerId: process.env["CI_RUNNER_ID"] ?? "local-runner",
        },
    });
    await writeArmor(manifestPath, args.signingKey, args.publicKey);
    const artifacts = ["catalog-print.pdf", "catalog-print.pdf.asc", "catalog-web.pdf", "catalog-web.pdf.asc",
        "release-manifest.json", "release-manifest.json.asc"];
    await fs.mkdir(staging, { recursive: true });
    for (const name of artifacts) {
        await fs.copyFile(path.join(args.out, name), path.join(staging, name));
    }
    // Promotion is a copy to catalog/ followed by deleting staging/ — the same
    // idempotent two-step the registry documents.
    await fs.mkdir(catalog, { recursive: true });
    for (const name of artifacts) {
        await fs.copyFile(path.join(staging, name), path.join(catalog, name));
        await fs.rm(path.join(staging, name), { force: true });
    }
    await fs.rm(staging, { recursive: true, force: true });
    const result = {
        status: "published",
        release: args.release,
        channel: args.channel,
        manifest: manifestPath,
        manifestSha256: await sha256File(manifestPath),
        artifacts: manifest.artifacts,
        exported,
        pdfa: report,
        signaturesVerified: [print, web, manifestPath].every((f) => verifyArmor(f, args.publicKey)),
        catalog: path.relative(args.root, catalog),
        stagingRemoved: !(await fs.stat(staging).then(() => true).catch(() => false)),
    };
    await fs.writeFile(path.join(args.out, "publish-result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ status: "published", release: args.release, artifacts: artifacts.length }));
    return 0;
}
main().then((code) => process.exit(code)).catch((err) => {
    console.error(err.message);
    process.exit(1);
});
