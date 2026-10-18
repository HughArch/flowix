/** Shared surface support and routing metadata for Work and Browser hosts. */
export {
  resolveWorkspaceFileSurfaceKind,
  workspaceFileSurfaceKind,
  workspaceFileSurfaceSupportsHost,
  workspaceSurfaceCapabilities,
  workspaceSurfaceAppearance,
  workspaceSurfaceRegistry,
  workspaceSurfaceSupportsHost,
} from '../surface-registry';
export type {
  WorkspaceFileSurfaceKind,
  WorkspaceSurfaceCapability,
  WorkspaceSurfaceHost,
  WorkspaceSurfaceKind,
} from '../surface-registry';

export type * from '../model/surface-contract';
export type * from '../model/surface-target';
export type { ContentIdentity, WorkspaceSurfaceIdentity } from '../model/surface-identity';
export { contentIdentityKey, workspaceSurfaceIdentityKey } from '../model/surface-identity';
