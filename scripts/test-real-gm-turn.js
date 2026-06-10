const endpoint = (process.env.GM_TEST_URL || "http://localhost:8787").replace(/\/+$/, "");
const mode = process.env.GM_MODE || "openai-compatible";
const apiKey = process.env.GM_API_KEY || process.env.OPENAI_API_KEY || "";
const baseUrl = process.env.GM_BASE_URL || "https://api.openai.com/v1";
const model = process.env.GM_MODEL || "gpt-4.1-mini";
const action = process.env.GM_TEST_ACTION || "选择谨慎观察周围人物与环境变化，等待 GM 裁定后续发展。";

if (mode !== "mock" && !apiKey) {
  console.error("缺少 API Key。请先设置 GM_API_KEY 或 OPENAI_API_KEY，再运行 npm run test:gm。");
  process.exit(1);
}

async function request(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

async function ensureAdventureState() {
  const bootstrap = await request("/api/bootstrap");
  if (bootstrap.state?.phase === "adventure" && bootstrap.state?.hero) {
    return bootstrap.state;
  }

  const payload = {
    name: "测试旅者",
    raceId: "human",
    stats: { STR: 6, AGI: 6, VIT: 6, INT: 6, MEN: 4, MP: 4 },
    mainTalentId: "none",
    subTalentId: "none"
  };
  const created = await request("/api/create-character", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return created.state;
}

function printTurn(state) {
  const last = state.lastTurn || {};
  console.log("\n=== 真实 GM 生成测试完成 ===");
  console.log(`回合：${state.turn}`);
  console.log(`位置：${state.world?.location || "未知"}`);
  console.log(`主角：${state.hero?.name || "未知"}`);
  console.log("\n--- 场景正文预览 ---");
  console.log(String(last.scene || "").slice(0, 900));
  console.log("\n--- 可选行动 ---");
  for (const option of last.options || []) {
    console.log(`${option.id}. ${option.title} - ${option.description}`);
  }
}

try {
  await ensureAdventureState();
  const result = await request("/api/turn", {
    method: "POST",
    body: JSON.stringify({
      action,
      provider: { mode, baseUrl, model, apiKey }
    })
  });
  printTurn(result.state);
} catch (error) {
  console.error("\n=== 真实 GM 生成测试失败 ===");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
