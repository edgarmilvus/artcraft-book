// app/layout.tsx — root layout.
//
// The chapter ships `app/studio/page.tsx` and the API routes but no root
// layout, and Next's App Router refuses to build a page without one
// ("studio/page.tsx doesn't have a root layout"), which 500s every route in
// the project. This is the minimal layout that fixes it.
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Studio — layered generation',
  description: 'Chapter 1 basic example: brief → plan → layered document',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
