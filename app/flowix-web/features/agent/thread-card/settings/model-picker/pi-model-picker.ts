import type { AgentModelOption } from "./model-picker-types";

type PiModelPickerProps = {
  models: readonly AgentModelOption[];
  showMemberTab: boolean;
  selectedModelId: string;
  selectedProviderId?: string;
  memberLabel: string;
  mineLabel: string;
  modelLabel: string;
  emptyLabel: string;
  personalEmptyLabel: string;
  createModelItem: (model: AgentModelOption) => HTMLElement;
};

type PiModelCategory = "member" | "mine";
type ProviderLabelPlacement = "group" | "item" | "none";

let nextTabSetId = 0;

export function isFlowixCloudModelOption(model: AgentModelOption): boolean {
  return model.providerName?.trim().toLocaleLowerCase() === "flowix cloud"
    || model.providerId?.trim().toLocaleLowerCase().startsWith("flowix-cloud") === true;
}

function groupModels(models: readonly AgentModelOption[]) {
  const groups = new Map<string, { label: string; models: AgentModelOption[] }>();
  models.forEach((model) => {
    const label = providerLabel(model);
    const key = model.providerId?.trim() || label;
    const group = groups.get(key);
    if (group) {
      group.models.push(model);
    } else {
      groups.set(key, { label, models: [model] });
    }
  });
  return [...groups.values()];
}

function providerLabel(model: AgentModelOption): string {
  return model.providerName?.trim() || model.providerId?.trim() || "Other";
}

function createModelGroups(
  models: readonly AgentModelOption[],
  props: PiModelPickerProps,
  providerLabelPlacement: ProviderLabelPlacement,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "pi-model-picker__models";

  groupModels(models).forEach((group) => {
    const groupElement = document.createElement("section");
    groupElement.className = "pi-model-picker__provider";
    groupElement.setAttribute("role", "group");
    groupElement.setAttribute("aria-label", group.label);

    if (providerLabelPlacement === "group") {
      const heading = document.createElement("div");
      heading.className = "pi-model-picker__provider-label";
      heading.textContent = group.label;
      groupElement.append(heading);
    }

    group.models.forEach((model) => {
      const item = props.createModelItem(model);
      item.classList.add("pi-model-picker__item");
      const subtitle = isFlowixCloudModelOption(model) ? model.subtitle?.trim() : undefined;
      if (subtitle) item.title = subtitle;
      const checkmark = item.querySelector(".agent-thread-card__copy-icon");
      if (providerLabelPlacement === "item") {
        const providerName = document.createElement("span");
        providerName.className = "pi-model-picker__provider-name";
        providerName.textContent = group.label;
        providerName.title = group.label;
        item.insertBefore(providerName, checkmark);
      }
      if (isFlowixCloudModelOption(model) && model.creditMultiplier != null) {
        const multiplier = document.createElement("span");
        multiplier.className = "pi-model-picker__multiplier";
        multiplier.textContent = `${model.creditMultiplier.toFixed(2)}x`;
        multiplier.setAttribute(
          "aria-label",
          `credit multiplier ${model.creditMultiplier.toFixed(2)}`,
        );
        item.insertBefore(multiplier, checkmark);
      }
      if (!checkmark) {
        const checkmarkPlaceholder = document.createElement("span");
        checkmarkPlaceholder.className = "pi-model-picker__checkmark-placeholder";
        checkmarkPlaceholder.setAttribute("aria-hidden", "true");
        item.append(checkmarkPlaceholder);
      }
      const providerIcon = item.querySelector(".agent-thread-card__model-provider-icon");
      if (providerIcon) {
        providerIcon.classList.add("pi-model-picker__provider-icon");
        item.prepend(providerIcon);
      }
      item.removeAttribute("role");
      item.removeAttribute("aria-checked");
      item.setAttribute(
        "aria-pressed",
        model.id === props.selectedModelId
          && (model.providerId ?? "") === (props.selectedProviderId ?? "")
          ? "true"
          : "false",
      );
      groupElement.append(item);
    });
    list.append(groupElement);
  });
  return list;
}

export function createPiModelPicker(props: PiModelPickerProps): HTMLElement {
  const root = document.createElement("div");
  root.className = "pi-model-picker";

  if (props.models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pi-model-picker__empty";
    empty.textContent = props.emptyLabel;
    root.append(empty);
    return root;
  }

  const memberModels = props.models.filter(isFlowixCloudModelOption);
  const mineModels = props.models.filter((model) => !isFlowixCloudModelOption(model));
  if (!props.showMemberTab || memberModels.length === 0) {
    const panel = document.createElement("div");
    panel.className = "pi-model-picker__panel";
    panel.append(createModelGroups(props.models, props, "item"));
    root.append(panel);
    return root;
  }

  const tabSetId = `pi-model-picker-${++nextTabSetId}`;
  const memberTabId = `${tabSetId}-member-tab`;
  const mineTabId = `${tabSetId}-mine-tab`;
  const panelId = `${tabSetId}-panel`;
  const tabList = document.createElement("div");
  tabList.className = "pi-model-picker__tabs";
  tabList.setAttribute("role", "tablist");
  tabList.setAttribute("aria-label", props.modelLabel);

  const memberTab = document.createElement("button");
  memberTab.type = "button";
  memberTab.id = memberTabId;
  memberTab.className = "pi-model-picker__tab";
  memberTab.setAttribute("role", "tab");
  memberTab.setAttribute("aria-controls", panelId);
  memberTab.textContent = props.memberLabel;

  const mineTab = document.createElement("button");
  mineTab.type = "button";
  mineTab.id = mineTabId;
  mineTab.className = "pi-model-picker__tab";
  mineTab.setAttribute("role", "tab");
  mineTab.setAttribute("aria-controls", panelId);
  mineTab.textContent = props.mineLabel;
  tabList.append(memberTab, mineTab);

  const panel = document.createElement("div");
  panel.id = panelId;
  panel.className = "pi-model-picker__panel";
  panel.setAttribute("role", "tabpanel");

  const selectedModel = props.models.find((model) =>
    model.id === props.selectedModelId
    && (model.providerId ?? "") === (props.selectedProviderId ?? ""),
  );
  const selectedModelIsCloud = selectedModel
    ? isFlowixCloudModelOption(selectedModel)
    : props.selectedProviderId?.trim().toLocaleLowerCase().startsWith("flowix-cloud") === true;
  let activeCategory: PiModelCategory = selectedModelIsCloud ? "member" : "mine";

  const selectCategory = (category: PiModelCategory, focusTab = false) => {
    activeCategory = category;
    const memberSelected = category === "member";
    memberTab.setAttribute("aria-selected", String(memberSelected));
    mineTab.setAttribute("aria-selected", String(!memberSelected));
    memberTab.tabIndex = memberSelected ? 0 : -1;
    mineTab.tabIndex = memberSelected ? -1 : 0;
    memberTab.classList.toggle("pi-model-picker__tab--active", memberSelected);
    mineTab.classList.toggle("pi-model-picker__tab--active", !memberSelected);
    panel.setAttribute("aria-labelledby", memberSelected ? memberTabId : mineTabId);
    panel.replaceChildren();

    const categoryModels = memberSelected ? memberModels : mineModels;
    if (categoryModels.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pi-model-picker__empty";
      empty.textContent = props.personalEmptyLabel;
      panel.append(empty);
    } else {
      panel.append(createModelGroups(
        categoryModels,
        props,
        memberSelected ? "none" : "item",
      ));
    }
    if (focusTab) (memberSelected ? memberTab : mineTab).focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent) => {
    let next: PiModelCategory | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = activeCategory === "member" ? "mine" : "member";
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = activeCategory === "member" ? "mine" : "member";
    } else if (event.key === "Home") {
      next = "member";
    } else if (event.key === "End") {
      next = "mine";
    }
    if (!next) return;
    event.preventDefault();
    selectCategory(next, true);
  };

  memberTab.addEventListener("click", () => selectCategory("member"));
  mineTab.addEventListener("click", () => selectCategory("mine"));
  memberTab.addEventListener("keydown", handleTabKeyDown);
  mineTab.addEventListener("keydown", handleTabKeyDown);
  root.append(tabList, panel);
  selectCategory(activeCategory);
  return root;
}
