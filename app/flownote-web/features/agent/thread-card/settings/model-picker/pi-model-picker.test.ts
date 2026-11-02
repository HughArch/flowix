import { describe, expect, it } from "vitest";
import type { AgentModelOption } from "./model-picker-types";
import { createPiModelPicker } from "./pi-model-picker";

function createModelItem(model: AgentModelOption): HTMLElement {
  const item = document.createElement("button");
  const icon = document.createElement("img");
  icon.className = "agent-thread-card__model-provider-icon";
  icon.src = "";
  icon.alt = "";
  const label = document.createElement("span");
  label.className = "agent-thread-card__codex-settings-item-label";
  label.textContent = model.label;
  item.append(icon, label);
  if (model.id === "deepseek-v3.2") {
    const checkmark = document.createElement("span");
    checkmark.className = "agent-thread-card__copy-icon";
    item.append(checkmark);
  }
  return item;
}

describe("Pi model picker", () => {
  it("renders providers in a flat panel", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "member-model",
          label: "Member model",
          providerId: "provider-a",
          providerName: "Provider A",
        },
        {
          id: "custom-model",
          label: "Custom model",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      selectedModelId: "custom-model",
      selectedProviderId: "custom-provider",
      emptyLabel: "没有模型",
      createModelItem,
    });

    expect(picker.querySelector(".pi-model-picker__category-label")).toBeNull();
    expect(picker.querySelector(".pi-model-picker__panel > .pi-model-picker__models"))
      .not.toBeNull();
    expect(picker.querySelector(".pi-model-picker__provider-label")).toBeNull();
    expect(picker.querySelectorAll(".pi-model-picker__item")).toHaveLength(2);
  });

  it("uses the personal model item layout with provider name and placeholder", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "custom-model",
          label: "custom-model",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      selectedModelId: "custom-model",
      selectedProviderId: "custom-provider",
      emptyLabel: "没有模型",
      createModelItem,
    });

    const item = picker.querySelector<HTMLButtonElement>(".pi-model-picker__item");
    const providerName = item?.querySelector(".pi-model-picker__provider-name");
    expect(item?.querySelector(".pi-model-picker__provider-icon")).not.toBeNull();
    expect(providerName?.textContent).toBe("My provider");
    const checkmarkPlaceholder = item?.querySelector(
      ".pi-model-picker__checkmark-placeholder",
    );
    expect(checkmarkPlaceholder?.getAttribute("aria-hidden")).toBe("true");
    expect(providerName?.nextElementSibling).toBe(checkmarkPlaceholder);
  });

  it("keeps the provider icon before the model key", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "deepseek-v3.2",
          label: "deepseek-v3.2",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      selectedModelId: "deepseek-v3.2",
      selectedProviderId: "custom-provider",
      emptyLabel: "没有模型",
      createModelItem,
    });

    const item = picker.querySelector<HTMLButtonElement>(".pi-model-picker__item");
    const icon = item?.querySelector(".pi-model-picker__provider-icon");
    expect(icon).not.toBeNull();
    expect(item?.firstElementChild).toBe(icon);
    expect(item?.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("deepseek-v3.2");
    expect(item?.querySelector(".pi-model-picker__multiplier")).toBeNull();
  });
});
