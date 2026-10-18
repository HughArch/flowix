import { describe, expect, it } from "vitest";
import type { AgentModelOption } from "./model-picker-types";
import { createPiModelPicker } from "./pi-model-picker";

function createModelItem(model: AgentModelOption): HTMLElement {
  const item = document.createElement("button");
  const icon = document.createElement("img");
  icon.className = "agent-thread-card__model-provider-icon";
  icon.src = model.iconUrl ?? "";
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

describe("Pi model picker provider icons", () => {
  it("uses the personal model item layout when member tabs are hidden", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "custom-model",
          label: "custom-model",
          iconUrl: "https://example.com/provider-icons/custom.png",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      showMemberTab: false,
      selectedModelId: "custom-model",
      selectedProviderId: "custom-provider",
      memberLabel: "会员",
      mineLabel: "我的",
      modelLabel: "模型",
      emptyLabel: "没有模型",
      personalEmptyLabel: "还没有自定义模型",
      createModelItem,
    });

    const item = picker.querySelector<HTMLButtonElement>(".pi-model-picker__item");
    const providerName = item?.querySelector(".pi-model-picker__provider-name");
    expect(picker.querySelector(".pi-model-picker__tabs")).toBeNull();
    expect(picker.querySelector(".pi-model-picker__panel > .pi-model-picker__models"))
      .not.toBeNull();
    expect(picker.querySelector(".pi-model-picker__provider-label")).toBeNull();
    expect(item?.querySelector(".pi-model-picker__provider-icon")).not.toBeNull();
    expect(providerName?.textContent).toBe("My provider");
    const checkmarkPlaceholder = item?.querySelector(
      ".pi-model-picker__checkmark-placeholder",
    );
    expect(checkmarkPlaceholder?.getAttribute("aria-hidden")).toBe("true");
    expect(providerName?.nextElementSibling).toBe(checkmarkPlaceholder);
  });

  it("shows the provider icon before the model key in both member and personal tabs", () => {
    const picker = createPiModelPicker({
      models: [
        {
          id: "deepseek-v3.2",
          label: "deepseek-v3.2",
          subtitle: "稳定高速模型",
          creditMultiplier: 1.25,
          iconUrl: "https://staging-cloud.flowix.cc/provider-icons/deepseek.png",
          providerId: "flowix-cloud-member",
          providerName: "Flowix Cloud",
        },
        {
          id: "custom-model",
          label: "custom-model",
          iconUrl: "https://example.com/provider-icons/custom.png",
          providerId: "custom-provider",
          providerName: "My provider",
        },
      ],
      showMemberTab: true,
      selectedModelId: "deepseek-v3.2",
      selectedProviderId: "flowix-cloud-member",
      memberLabel: "会员",
      mineLabel: "我的",
      modelLabel: "模型",
      emptyLabel: "没有模型",
      personalEmptyLabel: "还没有自定义模型",
      createModelItem,
    });

    const memberItem = picker.querySelector<HTMLButtonElement>(".pi-model-picker__item");
    expect(memberItem?.title).toBe("稳定高速模型");
    const memberIcon = memberItem?.querySelector(".pi-model-picker__provider-icon");
    expect(memberIcon).not.toBeNull();
    expect(memberItem?.firstElementChild).toBe(memberIcon);
    expect(memberItem?.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("deepseek-v3.2");
    const multiplier = memberItem?.querySelector(".pi-model-picker__multiplier");
    const checkmark = memberItem?.querySelector(".agent-thread-card__copy-icon");
    expect(multiplier?.textContent).toBe("1.25x");
    expect(multiplier?.nextElementSibling).toBe(checkmark);

    picker.querySelector<HTMLButtonElement>(".pi-model-picker__tab:nth-child(2)")?.click();
    const personalItem = picker.querySelector<HTMLButtonElement>(".pi-model-picker__item");
    const personalIcon = personalItem?.querySelector(".pi-model-picker__provider-icon");
    expect(personalIcon).not.toBeNull();
    expect(personalItem?.firstElementChild).toBe(personalIcon);
    expect(personalItem?.querySelector(".agent-thread-card__codex-settings-item-label")?.textContent)
      .toBe("custom-model");
    const providerName = personalItem?.querySelector(".pi-model-picker__provider-name");
    expect(providerName?.textContent).toBe("My provider");
    expect(providerName?.nextElementSibling?.classList.contains(
      "pi-model-picker__checkmark-placeholder",
    )).toBe(true);
    expect(picker.querySelector(".pi-model-picker__provider-label")).toBeNull();
  });
});
