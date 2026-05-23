// @ts-nocheck
import { state, els } from "./state.js";
import * as View from "../view.js";
import { api, showError } from "./api.js";
import { startSession } from "./session.js";

export async function loadConfig() {
  const config = await api("/api/config/models");
  state.config = config;
  state.providers = config.providers || [];
  renderProviders();
  renderConfigModels();
  return config;
}

export async function saveConfig(event) {
  event.preventDefault();
  const providerType = View.providerTypeFor(els.providerInput.value, state.providers);
  const existingModels = [...(state.config?.models || [])];
  const modelName = els.modelNameInput.value.trim();
  const baseURL = els.baseUrlInput.value.trim();
  const APIKey = els.apiKeyInput.value.trim();
  const hasNewModel = Boolean(modelName || baseURL || APIKey);
  let models = existingModels;

  if (hasNewModel) {
    const existingModel = models.find((model) => model.name === modelName);
    const canKeepExistingKey = Boolean(existingModel?.hasAPIKey || existingModel?.APIKey);
    if (!modelName || !baseURL || (!APIKey && !canKeepExistingKey)) {
      showError("Model name, base URL, and API key are required for a new model. Existing models can keep their saved key.");
      return;
    }
    const nextModel = { name: modelName, baseURL, APIKey, provider: providerType };
    const existingIndex = models.findIndex((model) => model.name === modelName);
    models =
      existingIndex >= 0
        ? models.map((model, index) => (index === existingIndex ? nextModel : model))
        : [...models, nextModel];
  }

  const defaultModel = els.defaultModelInput.value || modelName || models[0]?.name;
  if (!models.length || !defaultModel) {
    showError("Add at least one model before saving.");
    return;
  }

  await api("/api/config/models", {
    method: "POST",
    body: {
      models: models.map((model) => ({
        name: model.name,
        baseURL: model.baseURL,
        APIKey: model.APIKey || "",
        provider: model.provider || "openai",
      })),
      defaultModel,
    },
  });
  els.configDialog.close();
  resetModelForm();
  await loadConfig();
  if (!state.session) {
    await startSession();
  }
}

export function renderProviders() {
  els.providerInput.innerHTML = View.renderProviderOptions(state.providers, "openai");
  els.baseUrlInput.value = View.providerBaseURLFor(els.providerInput.value, state.providers);
}

export function renderConfigModels() {
  const models = state.config?.models || [];
  if (els.modelConfigSummary) {
    els.modelConfigSummary.textContent = `Config: ${state.config?.configPath || "unknown"} · default: ${state.config?.defaultModel || "none"}`;
  }
  els.modelList.innerHTML = View.renderConfiguredModelsHTML(models);
  els.defaultModelInput.innerHTML = View.renderDefaultModelOptions(models, state.config?.defaultModel);
  els.modelList.querySelectorAll("[data-edit-model]").forEach((button) => {
    button.addEventListener("click", () => editConfiguredModel(button.dataset.editModel));
  });
  els.modelList.querySelectorAll("[data-delete-model]").forEach((button) => {
    button.addEventListener("click", () => removeConfiguredModel(button.dataset.deleteModel));
  });
}

export async function openConfigDialog() {
  await loadConfig();
  resetModelForm();
  els.configDialog.showModal();
}

export function removeConfiguredModel(name) {
  const models = (state.config?.models || []).filter((model) => model.name !== name);
  const defaultModel = state.config?.defaultModel === name ? models[0]?.name : state.config?.defaultModel;
  state.config = { ...(state.config || {}), models, defaultModel };
  renderConfigModels();
}

export function editConfiguredModel(name) {
  const model = (state.config?.models || []).find((item) => item.name === name);
  if (!model) return;
  const providerId = providerIdForModel(model);
  els.providerInput.value = providerId;
  els.modelNameInput.value = model.name || "";
  els.baseUrlInput.value = model.baseURL || View.providerBaseURLFor(providerId, state.providers);
  els.apiKeyInput.value = "";
}

export function providerIdForModel(model) {
  return (
    state.providers.find((provider) => provider.providerType === model.provider && provider.baseURL === model.baseURL)?.id ||
    state.providers.find((provider) => provider.providerType === model.provider)?.id ||
    "openai"
  );
}

export function resetModelForm() {
  els.modelNameInput.value = "";
  els.apiKeyInput.value = "";
  renderProviders();
}
