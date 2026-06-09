import type { BootstrapResponse, GameState, GrowthProposal, ProviderConfig } from "./types";

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data as T;
}

export function getBootstrap() {
  return request<BootstrapResponse>("/api/bootstrap");
}

export function exportData() {
  return request<unknown>("/api/export");
}

export function resetGame() {
  return request<{ ok: true; state: GameState }>("/api/reset", {
    method: "POST",
    body: "{}"
  });
}

export function createCharacter(payload: unknown) {
  return request<{ ok: true; state: GameState }>("/api/create-character", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function runTurn(action: string, provider: ProviderConfig) {
  return request<{
    ok: true;
    state: GameState;
    sessionSummary: BootstrapResponse["sessionSummary"];
    growthDue: boolean;
  }>("/api/turn", {
    method: "POST",
    body: JSON.stringify({ action, provider })
  });
}

export function addLore(payload: { title: string; tags: string; content: string }) {
  return request<{ ok: true }>("/api/lore", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getGrowthProposals() {
  return request<{ ok: true; proposals: GrowthProposal[] }>("/api/growth/proposals");
}

export function analyzeGrowth(provider: ProviderConfig) {
  return request<{ ok: true; proposals: GrowthProposal[]; growthDue: boolean }>("/api/growth/analyze", {
    method: "POST",
    body: JSON.stringify({ provider })
  });
}

export function decideGrowthProposal(id: string, decision: "accepted" | "rejected") {
  return request<{ ok: true; proposal: GrowthProposal }>(`/api/growth/proposals/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision })
  });
}
