/**
 * pinecone-upsert.ts (excerpt from the worker's persistence stage)
 * ------------------------------------------------------------------
 * Every tenant gets its own namespace inside the shared index, and the
 * correlation id is the vector id, so re-running a job overwrites its own
 * row instead of duplicating it.
 */

export interface PineconeVector {
  id: string;
  values: number[];
  metadata: Record<string, string>;
}

export interface PineconeNamespace {
  upsert(vectors: PineconeVector[]): Promise<unknown>;
}

export interface PineconeIndex {
  namespace(name: string): PineconeNamespace;
}

export interface PineconeClient {
  index(name: string): PineconeIndex;
}

export interface BrandVector {
  tenantId: string;
  correlationId: string;
  embedding: number[];
  sku: string;
  svgPath: string;
  pngPath: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  petals: number;
}

export async function upsertBrandVector(
  pinecone: PineconeClient,
  brand: BrandVector,
): Promise<unknown> {
  return pinecone
    .index("vectorforge-assets")
    .namespace(`tenant_${brand.tenantId}_prod`)
    .upsert([
      {
        id: brand.correlationId,
        values: brand.embedding,
        metadata: {
          sku: brand.sku,
          svgPath: brand.svgPath,
          pngPath: brand.pngPath,
          palette: `${brand.primaryColor}/${brand.secondaryColor}/${brand.accentColor}`,
          petals: String(brand.petals),
        },
      },
    ]);
}
