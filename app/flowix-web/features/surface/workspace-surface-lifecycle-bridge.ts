import { useCallback, useRef } from 'react';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';

type SurfaceLifecycleProps = {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
  onFlushReady?: (flush: NonNullable<SurfaceLifecycle['flush']> | null, discard?: NonNullable<SurfaceLifecycle['discard']> | null) => void;
};

/** Each renderer owns its registration, including after another renderer replaces it. */
export function useWorkspaceSurfaceLifecycleBridge<T extends object>(
  props: T & SurfaceLifecycleProps,
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void,
): T & SurfaceLifecycleProps {
  const owner = useRef({});
  const ready = useRef<SurfaceLifecycle | null>(null);
  const saving = useRef<SurfaceLifecycle | null>(null);
  const publish = useCallback(() => {
    registerLifecycle?.(ready.current ?? saving.current, owner.current);
  }, [registerLifecycle]);
  const onSurfaceLifecycleReady = useCallback((lifecycle: SurfaceLifecycle | null) => {
    ready.current = lifecycle;
    publish();
    props.onSurfaceLifecycleReady?.(lifecycle);
  }, [props.onSurfaceLifecycleReady, publish]);
  // Document loading can precede editor/focus readiness. Adapt its early save
  // callback here so hosts always consult the same lifecycle registry.
  const onFlushReady = useCallback<NonNullable<SurfaceLifecycleProps['onFlushReady']>>((flush, discard) => {
    saving.current = flush ? { status: 'ready', flush, ...(discard ? { discard } : {}) } : null;
    if (!ready.current) publish();
    props.onFlushReady?.(flush, discard);
  }, [props.onFlushReady, publish]);
  return { ...props, onSurfaceLifecycleReady, onFlushReady };
}
