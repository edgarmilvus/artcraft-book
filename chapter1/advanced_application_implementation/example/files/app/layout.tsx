// app/layout.tsx — root layout for the Advanced example.
//
// Same gap as the Basic example: the chapter ships `app/(studio)/BriefComposer.tsx`
// and `app/api/art/brief/route.ts` but no root layout, so any page added under
// `app/` fails to build. Minimal, metadata-only layout.
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Art direction — brief composer',
  description: 'Chapter 1 advanced example: streaming art-direction brief',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
