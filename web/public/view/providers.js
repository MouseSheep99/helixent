import { escapeAttr, escapeHtml } from "./utils.js";

export function providerBaseURLFor(providerId, providers = []) {
  const provider = providers.find((item) => item.id === providerId);
  return provider?.baseURL ?? "";
}

export function providerTypeFor(providerId, providers = []) {
  const provider = providers.find((item) => item.id === providerId);
  return provider?.providerType ?? "openai";
}

export function renderProviderOptions(providers = [], selectedId = "openai") {
  return providers
    .map(
      (provider) => `
      <option
        value="${escapeAttr(provider.id)}"
        data-provider-type="${escapeAttr(provider.providerType)}"
        data-base-url="${escapeAttr(provider.baseURL)}"
        ${provider.id === selectedId ? "selected" : ""}
      >
        ${escapeHtml(provider.label)}
      </option>`,
    )
    .join("");
}

export function renderConfiguredModelsHTML(models = []) {
  if (!models.length) return `<div class="empty-state">No models configured.</div>`;
  return models
    .map(
      (model) => `
      <div class="list-item model-row">
        <span>
          <span class="list-item-title">
            <span>${escapeHtml(model.name)}</span>
            ${model.hasAPIKey ? `<span class="chip">${escapeHtml(model.APIKeyPreview || "key saved")}</span>` : ""}
          </span>
          <span class="list-item-detail">${escapeHtml(model.provider || "openai")} · ${escapeHtml(model.baseURL)}</span>
        </span>
        <button class="ghost-button mini-button" data-edit-model="${escapeAttr(model.name)}" type="button">Edit</button>
        <button class="ghost-button mini-button" data-delete-model="${escapeAttr(model.name)}" type="button">Delete</button>
      </div>`,
    )
    .join("");
}

export function renderDefaultModelOptions(models = [], defaultModel = "") {
  return models
    .map(
      (model) => `
      <option value="${escapeAttr(model.name)}" ${model.name === defaultModel ? "selected" : ""}>
        ${escapeHtml(model.name)}
      </option>`,
    )
    .join("");
}
