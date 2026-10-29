// run_forge.ts — deterministic harness for the graphics factory.
//
// The factory is driven against the real headless PhotoCraft: a feed of two
// products is rendered into every placement, the assets come from a stub
// fetcher (no network), and the second run has to hit the recipe cache.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { GraphicsFactory } from "./factory.js";
import { BrandKitSchema, PlacementSchema } from "./brand.js";
import { ProductFeedSchema } from "./schemas.js";

const OUTPUT = resolve(process.cwd(), "output");
const WORK = resolve(OUTPUT, "work");
const READ = resolve(WORK, "read");
const ASSETS = resolve(WORK, "assets");
// The banners land inside the engine's write root: a path outside it is
// refused.
const BANNERS = resolve(WORK, "out", "banners");

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

/** A product photo, 800×800. */
function makePhoto(seed: number): Buffer {
  const size = 800;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 40 + Math.floor(120 * Math.sin((x + seed * 30) / 90) * Math.cos(y / 120));
      png.data[i + 1] = 70 + Math.floor(90 * Math.cos((x + y + seed * 20) / 140));
      png.data[i + 2] = 130 + Math.floor(80 * Math.sin((x - y) / 70 + seed));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** The fetcher the asset resolver uses: it serves the two local photos. */
const images = new Map<string, Buffer>();
const fetchImpl = (async (input: string | URL) => {
  const url = String(input);
  const body = images.get(url);
  if (!body) {
    return { ok: false, status: 404, statusText: "Not Found" } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}) as unknown as typeof fetch;

const BRAND = {
  id: "acme",
  name: "Acme Outdoors",
  palette: {
    primary: "#0f766e",
    onPrimary: "#f0fdfa",
    surface: "#0b1020",
    onSurface: "#f5f7ff",
    accent: "#f59e0b",
    muted: "#334155",
  },
  logoUrl: "https://cdn.example/acme-logo.png",
  cta: "Shop now",
  fonts: {
    headline: "Inter-Bold",
    body: "Inter-Regular",
    price: "Inter-SemiBold",
  },
  safeZone: { top: 0.06, right: 0.06, bottom: 0.06, left: 0.06 },
};

const PLACEMENT = {
  id: "hero-1200x628",
  width: 1200,
  height: 628,
  layout: "hero-left",
};

const FEED = {
  version: 1,
  generatedAt: "2026-03-14T10:00:00.000Z",
  products: [
    {
      id: "sku-1",
      name: "Trailhead Pack 32L",
      brand: "Acme Outdoors",
      category: "bags",
      price: { amount: 129, currency: "USD" },
      sellingPoints: ["Ripstop nylon", "32 litres", "Lifetime warranty"],
      tags: ["new"],
      locale: "en-US",
      variants: [
        {
          sku: "sku-1-teal",
          label: "Teal",
          imageUrl: "https://cdn.example/pack-teal.png",
          badge: "NEW",
        },
        {
          sku: "sku-1-sand",
          label: "Sand",
          imageUrl: "https://cdn.example/pack-sand.png",
        },
      ],
    },
  ],
};

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  // The write root has to exist: the engine refuses to create it.
  for (const dir of [READ, ASSETS, resolve(WORK, "out"), BANNERS]) {
    mkdirSync(dir, { recursive: true });
  }

  images.set("https://cdn.example/pack-teal.png", makePhoto(0));
  images.set("https://cdn.example/pack-sand.png", makePhoto(1));
  images.set("https://cdn.example/acme-logo.png", makePhoto(2));

  console.log("\n# the contracts");
  const brand = BrandKitSchema.parse(BRAND);
  ok("brand: it validates", brand.palette.primary === "#0f766e");
  const placement = PlacementSchema.parse(PLACEMENT);
  equal("placement: the canvas is 1200 wide", placement.width, 1200);
  const feed = ProductFeedSchema.parse(FEED);
  equal("feed: one product", feed.products.length, 1);
  equal("feed: two variants", feed.products[0].variants.length, 2);

  writeFileSync(resolve(WORK, "feed.json"), JSON.stringify(FEED, null, 2));

  const factory = new GraphicsFactory({
    feedPath: resolve(WORK, "feed.json"),
    assetRoot: ASSETS,
    outRoot: BANNERS,
    readRoot: READ,
    writeRoot: resolve(WORK, "out"),
    fetchImpl,
  });

  console.log("\n# the run");
  const report = await factory.run({ brandJson: BRAND, placementsJson: [PLACEMENT] });
  equal("run: two banners were generated", report.generated.length, 2);
  equal("run: nothing failed", report.failed.length, 0);
  equal("run: nothing was reused", report.reused.length, 0);

  console.log("\n# the artifacts");
  for (const file of report.generated) {
    ok("artifact: the banner exists", existsSync(file), file);
    const png = PNG.sync.read(readFileSync(file));
    equal("artifact: the canvas is 1200 wide", png.width, 1200);
    equal("artifact: the canvas is 628 tall", png.height, 628);
  }
  const cached = readdirSync(ASSETS, { recursive: true } as any)
    .filter((name: any) => typeof name === "string" && name.includes("-"))
    .length;
  ok("run: the assets were cached", cached >= 3, `${cached}`);

  console.log("\n# the cache");
  const second = await factory.run({ brandJson: BRAND, placementsJson: [PLACEMENT] });
  equal("cache: nothing was generated", second.generated.length, 0);
  equal("cache: both banners were reused", second.reused.length, 2);

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
