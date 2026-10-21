/** Explicit provenance wins; names/ids are only a migration fallback. */
export function isFlowixCloudModel(model: {
  source?: "flowix-cloud" | "custom";
  providerId?: string;
  providerName?: string;
}): boolean {
  if (model.source) return model.source === "flowix-cloud";
  return model.providerName?.trim().toLowerCase() === "flowix cloud"
    || model.providerId?.trim().toLowerCase().startsWith("flowix-cloud") === true;
}
