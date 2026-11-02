import { Fragment, Suspense, type ReactNode } from 'react';
import { CenteredLoadingSpinner } from './centered-loading-spinner';

export type SurfaceLoadingTone = 'document' | 'agent' | 'media';

interface SurfaceSuspenseHostProps {
  instanceKey: string;
  loadingTone: SurfaceLoadingTone;
  children: ReactNode;
}

export function SurfaceSuspenseHost({
  instanceKey,
  loadingTone,
  children,
}: SurfaceSuspenseHostProps) {
  const fallbackClassName = loadingTone === 'agent' || loadingTone === 'media'
    ? 'bg-[var(--agent-bg,var(--document-bg))]'
    : '';
  return (
    <Suspense
      fallback={(
        <CenteredLoadingSpinner
          className={`h-full ${fallbackClassName}`}
        />
      )}
    >
      <Fragment key={instanceKey}>{children}</Fragment>
    </Suspense>
  );
}
