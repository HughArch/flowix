import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ surfaces: vi.fn(), preferences: vi.fn(), flush: vi.fn(), diagnostics: vi.fn(), invoke: vi.fn(), subscribe: vi.fn() }));
vi.mock('@platform/tauri/core', () => ({ invoke: mocks.invoke }));
vi.mock('@platform/tauri/event-bus', () => ({ subscribe: mocks.subscribe }));
vi.mock('@platform/tauri/runtime', () => ({ isTauriDesktopRuntime: () => true }));
vi.mock('@features/document/public/shutdown-api', () => ({ flushDocumentsForShutdown: mocks.flush, documentShutdownDiagnostics: mocks.diagnostics }));
vi.mock('@features/workspace/public/shutdown-api', () => ({ flushWorkspaceSurfacesForShutdown: mocks.surfaces }));
vi.mock('@features/preferences/public/shutdown-api', () => ({ flushPreferencesForShutdown: mocks.preferences }));
async function tick() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function install() { const module = await import('./desktop-shutdown'); module.installDesktopShutdown(); await tick(); return module; }
function emit(name: string, request: number) { mocks.subscribe.mock.calls.find(([event]) => event === name)![1](request); }
describe('native-owned shutdown preparation', () => {
  beforeEach(() => {
    vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.surfaces.mockResolvedValue(true); mocks.preferences.mockResolvedValue(undefined); mocks.flush.mockResolvedValue(true); mocks.invoke.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });
  it('installs once without a JS native-close interceptor', async () => {
    const module = await install(); module.installDesktopShutdown();
    expect(mocks.subscribe).toHaveBeenCalledTimes(3);
  });
  it('reports persistence success and leaves destruction to Rust', async () => {
    await install(); emit('document:prepare-close', 1); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 1, ready: true });
    expect(document.querySelector('dialog')).toBeNull();
  });
  it.each(['false', 'reject'])('still acknowledges close after save %s', async failure => {
    if (failure === 'false') mocks.flush.mockResolvedValue(false);
    else mocks.flush.mockRejectedValue(new Error('disk unavailable'));
    await install(); emit('document:prepare-close', 2); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 2, ready: false });
    expect(document.querySelector('dialog')).toBeNull();
  });
  it('leaves a stuck save to the native deadline without starting a second timer', async () => {
    vi.useFakeTimers(); mocks.flush.mockReturnValue(new Promise(() => {}));
    await install(); emit('document:prepare-close', 3); await tick();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_close', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });
  it('global quit captures fresh inputs and ignores the superseded acknowledgement', async () => {
    let finish!: (value: boolean) => void;
    mocks.flush.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await install(); emit('document:prepare-close', 4); await tick();
    emit('document:prepare-exit', 5); await tick(); finish(false); await tick();
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_close', expect.anything());
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_shutdown', { request: 5, ready: true });
  });
  it('restores interaction when the updater cancels', async () => {
    await install(); emit('document:prepare-exit', 6); emit('document:exit-cancelled', 6); await tick();
    expect(document.querySelector('dialog')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_shutdown', expect.anything());
  });
  it('diagnostics failure cannot prevent persistence or acknowledgement', async () => {
    mocks.diagnostics.mockImplementation(() => { throw new Error('diagnostics unavailable'); });
    await install(); emit('document:prepare-close', 11); await tick();
    expect(mocks.flush).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 11, ready: true });
  });
  it('does not show a blocking notice while persistence is pending', async () => {
    let finish!: (value: boolean) => void;
    mocks.flush.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await install(); emit('document:prepare-close', 12); await tick();
    expect(document.querySelector('dialog')).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_close', expect.anything());
    finish(true); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 12, ready: true });
  });
  it('closes immediately when all saves finish, without waiting one second', async () => {
    vi.useFakeTimers();
    await install(); emit('document:prepare-close', 8); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 8, ready: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts preferences and documents together and waits for both', async () => {
    let finish!: () => void;
    mocks.preferences.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    await install(); emit('document:prepare-close', 9); await tick();
    expect(mocks.flush).toHaveBeenCalledTimes(1);
    expect(mocks.preferences).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_close', expect.anything());
    finish(); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 9, ready: true });
  });
  it('preference failure cannot veto closing', async () => {
    mocks.preferences.mockRejectedValueOnce(new Error('settings locked'));
    await install(); emit('document:prepare-close', 10); await tick();
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 10, ready: false });
  });

  it('flushes fresh preferences and surfaces after updater cancellation', async () => {
    let finish!: (value: boolean) => void;
    mocks.flush.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    await install(); emit('document:prepare-exit', 21); await tick();
    emit('document:exit-cancelled', 21);
    // The previous document write is still pending; new edits may now exist.
    emit('document:prepare-close', 22); await tick();
    expect(mocks.preferences).toHaveBeenCalledTimes(2);
    expect(mocks.surfaces).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenCalledWith('finish_document_close', { request: 22, ready: true });
    finish(true); await tick();
    expect(mocks.invoke).not.toHaveBeenCalledWith('finish_document_shutdown', { request: 21, ready: true });
  });

});
