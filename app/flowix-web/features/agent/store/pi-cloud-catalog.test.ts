// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "@/lib/constants";
vi.mock("@platform/tauri/client", () => ({ piModels: {} }));
import { useAgentDataStore } from "./agent-data-store";

const local = { id: "same-model", providerId: "deepseek", label: "Local", source: "custom" as const };
const member = { id: "same-model", providerId: "flowix-cloud-member", label: "Member", source: "flowix-cloud" as const };

beforeEach(() => {
  localStorage.clear();
  useAgentDataStore.setState(useAgentDataStore.getInitialState(), true);
});

describe("Pi session catalog persistence", () => {
  it("uses explicit provenance when a custom provider has a Cloud-looking name", () => {
    const custom = { ...local, providerId: "flowix-cloud-own", providerName: "Flowix Cloud" };
    const store = useAgentDataStore.getState();
    store.setModelCatalog("pi", { items: [custom], defaultModel: custom.id, defaultProviderId: custom.providerId });
    expect(useAgentDataStore.getState().agents.pi.catalog.models.items).toEqual([custom]);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
    expect(persisted.state.agents.pi.catalog.models.defaultProviderId).toBe(custom.providerId);
  });

  it("preserves the live member overlay across storage rehydration and keeps a same-id local default", async () => {
    const store = useAgentDataStore.getState();
    const membership = {
      active: true,
      usedBytes: 10,
      quotaBytes: 100,
      availableBytes: 90,
      noteCount: 1,
      readOnly: false,
    };
    store.setPiCloudAccount("user", 2, membership);
    store.setModelCatalog("pi", {
      items: [member, local], defaultModel: local.id, defaultProviderId: local.providerId, updatedAt: 100,
    });
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DATA)!);
    expect(persisted.state.agents.pi.catalog.models.items).toEqual([local]);
    expect(persisted.state.agents.pi.catalog.models.defaultProviderId).toBe(local.providerId);
    // A preferences write in another window returns the same timestamp but
    // only the persistent local projection of the catalog.
    persisted.state.agents.pi.user.mode = "code";
    localStorage.setItem(STORAGE_KEYS.AGENT_DATA, JSON.stringify(persisted));
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentDataStore.getState().agents.pi.catalog.models.items).toEqual([member, local]);
    expect(useAgentDataStore.getState().piCloudMembership).toEqual(membership);
    store.setPiCloudAccount(null, 3);
    expect(useAgentDataStore.getState().piCloudMembership).toBeNull();
    expect(useAgentDataStore.getState().agents.pi.catalog.models).toMatchObject({
      items: [local], defaultModel: local.id, defaultProviderId: local.providerId,
    });
    await useAgentDataStore.persist.rehydrate();
    expect(useAgentDataStore.getState().agents.pi.catalog.models.items).toEqual([local]);
  });

  it("rejects a stale account snapshot and discards a catalog request from the previous session", async () => {
    const store = useAgentDataStore.getState();
    store.setPiCloudAccount("user", 2);
    let resolve!: (catalog: { items: typeof member[] }) => void;
    const request = store.loadModelCatalog("pi", () => new Promise(done => { resolve = done; }), { force: true });
    store.setPiCloudAccount(null, 3);
    store.setPiCloudAccount("user", 2);
    resolve({ items: [member] });
    await request;
    expect(useAgentDataStore.getState().piCloudAccountId).toBeNull();
    expect(useAgentDataStore.getState().agents.pi.catalog.models.items).toEqual([]);
  });
});
