/**
 * banner-factory.ts — a minimum viable e-commerce banner generator.
 *
 * The function `renderBanner` is the entire pipeline: it accepts one
 * product record, drives a headless PhotoCraft session through the MCP
 * meta-tools, and writes a PNG to disk. Everything else in the file is
 * scaffolding: the wire schema, the client bootstrap, and the one
 * example invocation at the bottom.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* ------------------------------------------------------------------ */
/* 1. WIRE SCHEMA — the contract between the feed and the renderer.    */
/* ------------------------------------------------------------------ */

/**
 * Runtime validator for a single product. We use Zod here not because
 * the type system needs help, but because a webhook from Shopify, a
 * nightly CSV export, and a manual curl request will all hit the same
 * endpoint. Zod gives us one canonical answer per field at the boundary
 * (parse-don't-validate) instead of scattering `if (typeof x === …)`
 * checks through the renderer.
 */
const ProductSchema = z.object({
  /** Human-readable product name, printed on the banner. */
  name: z.string().min(1).max(120),
  /** Price in minor units (e.g. cents). Formatted below. */
  priceMinorUnits: z.number().int().nonnegative(),
  /** ISO-4217 currency code, uppercase. */
  currency: z.enum(["USD", "EUR", "GBP", "JPY"]),
  /** Absolute or read-root-relative path to the hero image. */
  imagePath: z.string().min(1),
  /** Optional short badge ("NEW", "-20%"). Empty string means none. */
  badge: z.string().max(16).default(""),
  /** Background colour as a `#rrggbb` CSS literal. */
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Foreground (text) colour as a `#rrggbb` CSS literal. */
  foreground: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

/** Compile-time view of the runtime schema. */
type Product = z.infer<typeof ProductSchema>;

/* ------------------------------------------------------------------ */
/* 2. FORMATTERS — pure functions, no side effects, easy to unit-test. */
/* ------------------------------------------------------------------ */

/**
 * Turn 1299 + "USD" into "$12.99". Deliberately hand-rolled so the
 * example stays dependency-free and the output is deterministic across
 * Node versions; a production pipeline would use `Intl.NumberFormat`
 * with a fixed locale. The point of this helper is to show *once* that
 * data normalisation should happen before any engine command runs.
 */
export function formatPrice(minorUnits: number, currency: Product["currency"]): string {
  const symbol =
    currency === "USD" ? "$" :
    currency === "EUR" ? "€" :
    currency === "GBP" ? "£" :
    "¥"; // JPY
  // The yen has no minor unit: the amount is already in whole yen, so
  // dividing it by a hundred would print a price ten times too small.
  if (currency === "JPY") {
    return `${symbol}${groupThousands(String(Math.round(minorUnits)))}`;
  }
  // Integer division would drop the cents, so convert to string first
  // and pad explicitly. Using Number.prototype.toFixed is fine in this
  // range because minorUnits is capped by Zod to a safe integer.
  return `${symbol}${(minorUnits / 100).toFixed(2)}`;
}

/** Thousands separators, hand-rolled so the output never depends on the ICU. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Type narrowing demo: a "measurement" union whose measurement unit is
 * narrowed by a runtime discriminant tag. This is the same trick the
 * TypeScript compiler uses internally for discriminated unions, shown
 * here so the reader sees the pattern explicitly before we rely on it
 * implicitly inside `renderBanner`.
 */
type Measurement =
  | { unit: "px"; value: number }
  | { unit: "%"; value: number }
  | { unit: "pt"; value: number };

/**
 * Resolve a measurement against a reference pixel size. Because the
 * `unit` field is a literal-type discriminant, the switch below is
 * *exhaustive*: if someone later adds a `"em"` variant, TypeScript
 * refuses to compile this function until the new case is handled.
 * That is type narrowing in practice.
 */
function resolvePx(m: Measurement, reference: number): number {
  switch (m.unit) {
    case "px":
      // In this branch, TypeScript has narrowed `m` to
      // `{ unit: "px"; value: number }`, so `m.value` is legal.
      return m.value;
    case "%":
      return (m.value / 100) * reference;
    case "pt":
      // 1 pt = 1/72 in; at 96 dpi that is 1.333 px. We round to int
      // because every downstream engine command expects whole pixels.
      return Math.round(m.value * (96 / 72));
  }
}

/* ------------------------------------------------------------------ */
/* 3. THE PIPELINE — one function, one product, one PNG.               */
/* ------------------------------------------------------------------ */

/**
 * Render a single e-commerce banner.
 *
 * Frame of reference:
 *   - Source product schema:  `ProductSchema`
 *   - Target canvas:          1200 × 628 px, RGB, 8-bit
 *   - Layer stack (bottom→top): Background / Image / Name+Price / Badge
 *   - Output:                 `<outDir>/<slug>.png`
 *
 * Everything below is expressed as MCP meta-tool calls, which are the
 * stable public contract of PhotoCraft regardless of how many engine
 * commands the Rust side ships. `command_run` carries the concrete
 * command id (`type.create`, `object.transform`, …) and its parameters.
 *
 * @param raw   - unvalidated object straight off the wire
 * @param outDir - absolute directory where the PNG lands
 * @returns      - the resolved absolute path of the exported file
 * @throws       - if the product fails validation, the CLI refuses a
 *                 command, or the file cannot be written
 */
export async function renderBanner(
  raw: unknown,
  outDir: string,
  readRoot: string,
): Promise<string> {
  /* ---------------- 3a. Validate before touching the engine ------------ */
  // `parse` throws a ZodError with a machine-readable issue list. We do
  // NOT use `safeParse` here because a malformed product should stop the
  // whole batch — silently skipping records is how you ship the wrong
  // price to customers.
  const product: Product = ProductSchema.parse(raw);

  /* ---------------- 3b. Boot the CLI in MCP mode ---------------------- */
  // StdioClientTransport spawns `photocraft-cli mcp` as a child process
  // and wires its stdin/stdout to the JSON-RPC codec. The two flags pin
  // the filesystem sandbox so a malicious `imagePath` cannot escape.
  // The read root is the staging area the feed's images live in, and the
  // write root is the output folder: the two are different, and the engine
  // refuses a path that is outside the root it was given.
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: [
      "mcp",
      "--automation-read-root", resolve(readRoot),
      "--automation-write-root", resolve(outDir),
    ],
  });

  const client = new Client(
    { name: "banner-factory", version: "1.0.0" },
    { capabilities: {} },
  );

  // `connect` resolves once the handshake completes; from here on every
  // callTool round-trips a JSON-RPC frame.
  await client.connect(transport);

  /**
   * Every tool call goes through here. An MCP tool that refuses a command
   * answers with `isError` and a message; without this check the pipeline
   * would carry on with a document that is missing a layer, and the export
   * would be quietly wrong.
   */
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    if (result.isError) {
      const message = result.content?.find((block) => block.type === "text")?.text ?? "unknown error";
      throw new Error(`${name}: ${message}`);
    }
    const text = result.content?.find((block) => block.type === "text")?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  try {
    /* ------------ 3c. Create the canvas ------------------------------- */
    // doc_new is a *native* meta-tool (not a command_run passthrough)
    // because spawning documents is a first-class MCP concern: the reply
    // carries the document index that every subsequent call targets.
    await call("doc_new", {
        width: 1200,
        height: 628,
        mode: "rgb",
        depth: 8,
        // Background is written as its own layer during doc_new, so we
        // go straight from here to placing artwork.
        background: product.background,
      name: `banner-${product.name.slice(0, 24)}`,
    });

    /* ------------ 3d. Place the hero image --------------------------- */
    // We use `command_run` with `file.placeEmbedded`. Embedding (rather
    // than linking) keeps the exported PNG self-contained; linking would
    // be faster for a huge catalog but would break CDN packing later.
    // The transform is expressed as an absolute translate so we can
    // compose deterministically without reading the image's natural
    // dimensions.
    // `file.placeEmbedded` is disabled in the automation sandbox — it reads
    // an ambient path. The capability-scoped `doc_place` tool is the way in:
    // the path is resolved against the engine's read root.
    await call("doc_place", {
      path: product.imagePath,
      // The "right half" of a 1200×628 canvas.
      scale: 100,
      center: [900, 314], // px, canvas-space
    });

    /* -------- 3e. Create the product-name type layer ------------------ */
    // `type.create` expects the baseline anchor of point text. We place
    // the name in the left third of the canvas, top-aligned with a
    // comfortable optical margin.
    // The name is paragraph text in a box: a long product name wraps
    // instead of running off the canvas.
    await call("command_run", {
      id: "type.create",
      params: {
        x: 64,
        y: 120,
        box: [64, 110, 520, 160],
        align: "left",
        text: product.name.toUpperCase(),
        font: "Inter-Bold",
        size: 72,
        // 4-value fill lets us keep the foreground and background
        // independent; alpha is 1.
        color: product.foreground,
      },
    });

    /* -------- 3f. Create the price type layer ------------------------ */
    // A second type layer keeps editing granular; the alternative would
    // be a single text run with mixed formatting, which the feed cannot
    // reliably describe without a rich-text grammar.
    await call("command_run", {
      id: "type.create",
      params: {
        x: 64,
        y: 380,
        text: formatPrice(product.priceMinorUnits, product.currency),
        font: "Inter-SemiBold",
        size: 96,
        color: product.foreground,
      },
    });

    /* -------- 3g. Conditional badge layer --------------------------- */
    // This is where the discriminated-union trick pays off: the empty
    // string default means we can use a plain truthiness check and the
    // renderer never has to special-case "undefined".
    if (product.badge !== "") {
      await call("command_run", {
        id: "type.create",
        params: {
          x: 64,
          y: 64,
          text: product.badge,
          font: "Inter-Bold",
          size: 28,
          color: product.foreground,
        },
      });
    }

    /* -------- 3h. Render an audit preview ---------------------------- */
    // doc_render_preview returns the flattened canvas as PNG bytes; we
    // do not need it for the pipeline, but capturing one frame before
    // the export catches transform mistakes *before* the file hits the
    // CDN. In a real deployment these bytes would go to a vision model.
    await call("doc_render_preview", { max_side: 512 });

    /* -------- 3i. Export the final PNG ------------------------------ */
    // The write root pins the destination: any path outside it is
    // refused server-side, so a slug like `../../etc/passwd` cannot
    // escape even if the caller forgets to sanitise it.
    const slug = product.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);

    const outPath = resolve(outDir, `${slug}.png`);

    await call("doc_save", {
      path: outPath,
      format: "png",
    });

    return outPath;
  } finally {
    /* -------- 3j. Always release the child process ------------------- */
    // Without this the CLI stays alive holding file handles, and a CI
    // job that renders 500 banners leaks 500 processes. `finally` runs
    // even when `parse` or a `command_run` throws.
    await client.close();
  }
}

/* ------------------------------------------------------------------ */
/* 4. INVOCATION — the only code that actually needs the network.      */
/* ------------------------------------------------------------------ */

/**
 * In a real SaaS deployment this runs behind a POST /render endpoint;
 * for the Hello World we just call it once and print the result. The
 * try/catch mirrors the shape of a Next.js Route Handler: failures are
 * converted into a structured error body rather than an unhandled
 * rejection.
 */
async function main(): Promise<void> {
  try {
    const path = await renderBanner(
      {
        name: "Aurora Mechanical Keyboard",
        priceMinorUnits: 12900,
        currency: "USD",
        // The path is relative to the engine's read root, which is the
        // staging area the feed's images live in.
        imagePath: "aurora-keyboard.png",
        badge: "NEW",
        background: "#0b1020",
        foreground: "#f5f7ff",
      },
      "./out",
      "./samples",
    );
    // eslint-disable-next-line no-console -- this is the sample's UI.
    console.log(`✓ wrote ${path}`);
  } catch (err) {
    // In a web context this would be `return NextResponse.json({...},
    // { status: 400 })`. The shape of the error matters more than the
    // transport: downstream agents branch on `err.name`.
    console.error("banner render failed:", err);
    process.exitCode = 1;
  }
}

// Guard so that importing this file from a test does not auto-run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
