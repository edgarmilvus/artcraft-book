// ═══════════════════════════════════════════════════════════════════════════
// FILE 8/9 — app/(studio)/BriefComposer.tsx
// Client component: stream a single art-direction brief with `useCompletion`,
// then hand the text to the server's recipe compiler.
// ═══════════════════════════════════════════════════════════════════════════
'use client';

import { useCallback, useMemo, useState, type JSX } from 'react';
import { useCompletion } from '@ai-sdk/react';
import type { LayeredRecipe } from '@/artcraft/recipe.js';

/** Shape returned by POST /api/art/recipe. */
interface RecipeResponse {
  recipe: LayeredRecipe;
  warnings: string[];
}

/** Shape returned by POST /api/art/forge. */
interface ForgeResponse {
  jobId: string;
  masterPath: string;
  ledgerPath: string;
  deliverables: Array<{ id: string; path: string; format: string }>;
}

/**
 * The Brief Composer.
 *
 * `useCompletion` is deliberately chosen over `useChat`: the brief is a
 * single generated artifact with no turn structure, so the chat transport's
 * message array would be pure overhead, and its state machine would tempt us
 * into multi-turn prompt drift that makes recipes non-reproducible.
 */
export function BriefComposer(): JSX.Element {
  const [recipe, setRecipe] = useState<LayeredRecipe | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [forge, setForge] = useState<ForgeResponse | null>(null);
  const [forgeError, setForgeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const {
    completion,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    stop,
    error,
    setCompletion,
  } = useCompletion({
    api: '/api/art/brief',
    // The brief is plain text, so the default text stream protocol is correct.
    // Switching to a data stream would only be worthwhile if we also streamed
    // structured recipe fragments, which we do not: the recipe is produced by
    // a separate, schema-validated call so that a malformed stream can never
    // mutate a document.
    onFinish: async (_prompt: string, brief: string) => {
      setForge(null);
      setForgeError(null);
      const res = await fetch('/api/art/recipe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief }),
      });
      if (!res.ok) {
        setForgeError(await res.text());
        return;
      }
      const data = (await res.json()) as RecipeResponse;
      setRecipe(data.recipe);
      setWarnings(data.warnings);
    },
  });

  /** Dispatch the compiled recipe to the Forge pipeline. */
  const onForge = useCallback(async () => {
    if (!recipe) return;
    setBusy(true);
    setForgeError(null);
    try {
      const res = await fetch('/api/art/forge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipe, capture: 'preview' }),
      });
      if (!res.ok) throw new Error(await res.text());
      setForge((await res.json()) as ForgeResponse);
    } catch (e) {
      setForgeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [recipe]);

  const recipeDigestLabel = useMemo(
    () => (recipe ? `${recipe.stack.length} layers · ${recipe.delivery.length} deliverables` : '—'),
    [recipe],
  );

  return (
    <section className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="brief" className="block text-sm font-medium">
          Product description
        </label>
        <textarea
          id="brief"
          value={input}
          onChange={handleInputChange}
          rows={3}
          placeholder="Ceramic pour-over dripper, matte sand glaze, on oak."
          className="w-full rounded-md border p-3 font-mono text-sm"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={isLoading || input.trim().length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {isLoading ? 'Composing…' : 'Compose brief'}
          </button>
          {isLoading && (
            <button type="button" onClick={stop} className="text-sm underline">
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              // Clearing the completion is important: a stale brief silently
              // re-applied to the next job is the classic reproducibility bug.
              setCompletion('');
              setRecipe(null);
              setForge(null);
            }}
            className="text-sm underline"
          >
            Reset
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error.message}</p>}
      </form>

      <aside className="space-y-4 rounded-md border p-4">
        <header className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Art direction brief</h3>
          <span className="text-xs text-slate-500">{recipeDigestLabel}</span>
        </header>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">
          {completion || 'The brief will stream here.'}
        </pre>

        {warnings.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-amber-700">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <button
          type="button"
          disabled={!recipe || busy}
          onClick={onForge}
          className="w-full rounded-md bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {busy ? 'Forging…' : 'Forge layered master'}
        </button>

        {forgeError && <p className="text-xs text-red-600">{forgeError}</p>}

        {forge && (
          <dl className="space-y-1 text-xs">
            <dt className="font-medium">Master</dt>
            <dd className="break-all font-mono">{forge.masterPath}</dd>
            <dt className="font-medium">Ledger</dt>
            <dd className="break-all font-mono">{forge.ledgerPath}</dd>
            <dt className="font-medium">Deliverables</dt>
            <dd>
              <ul className="list-disc pl-5 font-mono">
                {forge.deliverables.map((d) => (
                  <li key={d.id}>{d.path}</li>
                ))}
              </ul>
            </dd>
          </dl>
        )}
      </aside>
    </section>
  );
}
