import { useCallback, useRef } from 'react';
import type { SurfaceLifecycle } from '@features/workspace/model/surface-contract';

type SurfaceLifecycleProps = {
  onSurfaceLifecycleReady?: (lifecycle: SurfaceLifecycle | null) => void;
};

/** Each renderer owns its registration, including after another renderer replaces it. */
export function useWorkspaceSurfaceLifecycleBridge<T extends object>(
  props: T & SurfaceLifecycleProps,
  registerLifecycle?: (lifecycle: SurfaceLifecycle | null, owner?: object) => void,
): T & SurfaceLifecycleProps {
  const owner = useRef({});
  const onSurfaceLifecycleReady = useCallback((lifecycle: SurfaceLifecycle | null) => {
    registerLifecycle?.(lifecycle, owner.current);
    props.onSurfaceLifecycleReady?.(lifecycle);
  }, [props.onSurfaceLifecycleReady, registerLifecycle]);
  return { ...props, onSurfaceLifecycleReady };
}
