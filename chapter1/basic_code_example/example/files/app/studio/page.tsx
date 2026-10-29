// ---------------------------------------------------------------------------
// app/studio/page.tsx
//
// Client-side companion: a textarea, and a *streamed* interpretation of the
// brief. The completion hook is used purely to show the user how their text
// is being read before the layered render is dispatched. The completion
// stream does not produce the artefact — it produces the *intent*, which
// then flows through the same plan → commands pipeline as above.
// ---------------------------------------------------------------------------

'use client';

import { useState } from 'react';
import { useCompletion } from '@ai-sdk/react';

export default function StudioPage() {
  const [brief, setBrief] = useState('A launch banner for a matte-black espresso machine');
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done'>('idle');
  const [documentPath, setDocumentPath] = useState<string | null>(null);

  // Non-conversational completion: one-shot, textual, cached.
  const { completion, complete, isLoading } = useCompletion({
    api: '/api/studio/interpret',
  });

  async function onRender() {
    setStatus('rendering');
    const res = await fetch('/api/studio/layered-render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brief, outputName: 'launch-banner' }),
    });
    const data = await res.json();
    setDocumentPath(data.document);
    setStatus('done');
  }

  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <h1>Studio — layered render</h1>

      <textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        rows={3}
        style={{ width: '100%' }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={() => complete(brief)} disabled={isLoading}>
          Interpret brief
        </button>
        <button onClick={onRender} disabled={status === 'rendering'}>
          Render as layered .pcraft
        </button>
      </div>

      {completion && (
        <pre style={{ marginTop: 16, whiteSpace: 'pre-wrap' }}>
          {completion}
        </pre>
      )}

      {status === 'done' && documentPath && (
        <p>Saved non-destructive document ➜ <code>{documentPath}</code></p>
      )}
    </main>
  );
}
