import type { ProviderConfig } from "./types";

const STORAGE_KEY = "rag-gm-provider";

export interface StoredProviderConfig extends ProviderConfig {
  saveKey: boolean;
}

export function loadProviderSettings(): StoredProviderConfig {
  const fallback: StoredProviderConfig = {
    mode: "mock",
    baseUrl: "",
    model: "",
    apiKey: "",
    saveKey: false
  };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;
  try {
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

export function saveProviderSettings(config: StoredProviderConfig) {
  if (!config.saveKey) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
