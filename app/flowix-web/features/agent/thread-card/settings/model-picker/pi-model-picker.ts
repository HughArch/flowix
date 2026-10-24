import type { AgentModelOption } from "./model-picker-types";

type PiModelPickerProps = {
  models: readonly AgentModelOption[];
  selectedModelId: string;
  selectedProviderId?: string;
  emptyLabel: string;
  createModelItem: (model: AgentModelOption) => HTMLElement;
};

type ProviderLabelPlacement = "group" | "item" | "none";

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
      const checkmark = item.querySelector(".agent-thread-card__copy-icon");
      if (providerLabelPlacement === "item") {
        const providerName = document.createElement("span");
        providerName.className = "pi-model-picker__provider-name";
        providerName.textContent = group.label;
        providerName.title = group.label;
        item.insertBefore(providerName, checkmark);
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

  const panel = document.createElement("div");
  panel.className = "pi-model-picker__panel";
  panel.append(createModelGroups(props.models, props, "item"));
  root.append(panel);
  return root;
}
