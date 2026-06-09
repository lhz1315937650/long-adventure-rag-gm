const root = document.querySelector("#root");
const worldLine = document.querySelector("#world-line");
const providerMode = document.querySelector("#provider-mode");
const baseUrl = document.querySelector("#base-url");
const model = document.querySelector("#model");
const apiKey = document.querySelector("#api-key");
const saveKey = document.querySelector("#save-key");
const exportBtn = document.querySelector("#export-btn");
const resetBtn = document.querySelector("#reset-btn");

const statNames = ["STR", "AGI", "VIT", "INT", "MEN", "MP"];
let appState = null;
let rules = null;
let sessionSummary = null;
let loreCount = 0;
let growthDue = false;
let growthProposals = [];
let selectedRaceId = null;
let busy = false;

loadProviderSettings();
bootstrap();

providerMode.addEventListener("change", saveProviderSettings);
baseUrl.addEventListener("input", saveProviderSettings);
model.addEventListener("input", saveProviderSettings);
apiKey.addEventListener("input", saveProviderSettings);
saveKey.addEventListener("change", saveProviderSettings);

exportBtn.addEventListener("click", async () => {
  const data = await request("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `long-adventure-rag-gm-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

resetBtn.addEventListener("click", async () => {
  if (!confirm("确定要重置本地存档和记忆吗？")) return;
  const data = await request("/api/reset", { method: "POST", body: "{}" });
  appState = data.state;
  sessionSummary = null;
  growthDue = false;
  render();
});

async function bootstrap() {
  try {
    const data = await request("/api/bootstrap");
    appState = data.state;
    rules = data.rules;
    sessionSummary = data.sessionSummary;
    loreCount = data.loreCount || 0;
    growthDue = Boolean(data.growthDue);
    await loadGrowthProposals();
    selectedRaceId = rules.races[0]?.id;
    render();
  } catch (error) {
    root.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

function render() {
  if (!appState || !rules) return;
  const world = appState.world || {};
  worldLine.textContent = `${world.location || "未知地点"} · ${world.time || "未知时间"} · 第 ${world.day || 1} 日`;
  if (appState.phase === "creation") renderCreation();
  else renderGame();
}

function renderCreation() {
  root.innerHTML = `
    <section class="creation-layout">
      <div class="notice">先创建角色。GM 只提供种族框架和数值规则，不预设背景、立场或成长路线。</div>
      <h2>角色创建</h2>
      <div class="creation-grid">
        ${rules.races.map(renderRaceCard).join("")}
      </div>
      <div class="creation-form">
        <div>
          <div class="field">
            <label for="hero-name">角色名</label>
            <input id="hero-name" placeholder="输入玩家角色名" />
          </div>
          <div class="section">
            <div class="remaining" id="remaining-points"></div>
            <div class="stat-grid" id="stat-grid"></div>
          </div>
        </div>
        <div>
          <div class="field">
            <label for="main-talent">核心天赋</label>
            <select id="main-talent">
              ${rules.mainTalents.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} - ${escapeHtml(item.description)}</option>`).join("")}
            </select>
          </div>
          <div class="field section">
            <label for="sub-talent">副天赋</label>
            <select id="sub-talent">
              ${rules.subTalents.map((item) => `<option value="${item.id}">${escapeHtml(item.name)} - ${escapeHtml(item.description)}</option>`).join("")}
            </select>
          </div>
          <div class="form-actions section">
            <button id="create-btn" class="primary-btn">创建角色</button>
          </div>
        </div>
      </div>
    </section>
  `;

  document.querySelectorAll("[data-race]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedRaceId = button.dataset.race;
      renderCreation();
    });
  });

  const statGrid = document.querySelector("#stat-grid");
  for (const stat of statNames) {
    const label = document.createElement("label");
    label.className = "stat-input";
    label.innerHTML = `<span>${stat}</span><input data-stat="${stat}" type="number" min="0" step="1" value="0" />`;
    statGrid.append(label);
  }
  statGrid.addEventListener("input", updateRemaining);
  document.querySelector("#create-btn").addEventListener("click", createCharacter);
  updateRemaining();
}

function renderRaceCard(race) {
  const selected = race.id === selectedRaceId ? "selected" : "";
  const growth = Object.entries(race.growth).map(([key, value]) => `${key} x${value}`).join(" · ");
  return `
    <article class="race-card ${selected}">
      <h3>${escapeHtml(race.name)}</h3>
      <p class="small">初始属性点：${race.initial_points}</p>
      <p class="small">成长：${escapeHtml(growth)}</p>
      <p class="small">天赋：${escapeHtml(race.talent.name)}，${escapeHtml(race.talent.description)}</p>
      <button class="plain-btn" data-race="${race.id}">${selected ? "已选择" : "选择"}</button>
    </article>
  `;
}

function updateRemaining() {
  const race = getSelectedRace();
  const used = getStatsFromInputs().sum;
  const remaining = race.initial_points - used;
  const target = document.querySelector("#remaining-points");
  target.textContent = `剩余属性点：${remaining}`;
  target.style.color = remaining === 0 ? "var(--accent-strong)" : "var(--rust)";
}

async function createCharacter() {
  const stats = getStatsFromInputs().stats;
  try {
    setBusy(true);
    const data = await request("/api/create-character", {
      method: "POST",
      body: JSON.stringify({
        name: document.querySelector("#hero-name").value,
        raceId: selectedRaceId,
        stats,
        mainTalentId: document.querySelector("#main-talent").value,
        subTalentId: document.querySelector("#sub-talent").value
      })
    });
    appState = data.state;
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(false);
  }
}

function renderGame() {
  const hero = appState.hero;
  const last = appState.lastTurn || {};
  root.innerHTML = `
    <section class="game-layout">
      <aside class="side">
        ${renderHeroCard(hero)}
        ${renderAbilities()}
        ${renderInventory()}
      </aside>
      <section class="scene-panel">
        <h2>场景正文</h2>
        <div class="scene-text">${escapeHtml(last.scene || "等待 GM 回合。")}</div>
        <div class="section">
          <h3>即时反应</h3>
          <div class="list">${toList(last.reactions)}</div>
        </div>
        <div class="section">
          <h3>可选行动</h3>
          <div class="option-grid">
            ${(last.options || []).map(renderOptionButton).join("")}
          </div>
        </div>
        <div class="section custom-action">
          <h3>自定义行动</h3>
          <textarea id="custom-action" placeholder="输入玩家自己的行动。GM 只裁定后果，不替玩家决定。"></textarea>
          <button id="custom-submit" class="primary-btn">提交行动</button>
        </div>
      </section>
      <aside class="right">
        <section>
          <h2>主要角色</h2>
          <div class="list">${renderNpcCards()}</div>
        </section>
        <section>
          <h2>世界状态</h2>
          <div class="mini-card">${escapeHtml(last.world_status || "暂无")}</div>
        </section>
        <section>
          <h2>剧情记录</h2>
          <div class="history-list">${renderHistory()}</div>
        </section>
        <section>
          <h2>会话记忆</h2>
          <div class="mini-card small">${escapeHtml(renderSessionSummary())}</div>
        </section>
        <section>
          <h2>资料库</h2>
          <div class="mini-card small">已收录 ${loreCount} 份资料。</div>
          <div class="custom-action section">
            <input id="lore-title" placeholder="资料标题" />
            <input id="lore-tags" placeholder="标签，用逗号分隔" />
            <textarea id="lore-content" placeholder="追加新的故事背景、势力、历史或设定。"></textarea>
            <button id="lore-submit" class="ghost-btn">保存资料</button>
          </div>
        </section>
        <section>
          <h2>自生长</h2>
          ${growthDue ? `<div class="notice">当前存档已达到建议审计阈值。</div>` : ""}
          <button id="growth-analyze" class="ghost-btn">运行自生长审计</button>
          <div class="list section">${renderGrowthProposals()}</div>
        </section>
      </aside>
    </section>
  `;

  document.querySelectorAll("[data-option]").forEach((button) => {
    button.addEventListener("click", () => runPlayerAction(button.dataset.option));
  });
  document.querySelector("#custom-submit").addEventListener("click", () => {
    const value = document.querySelector("#custom-action").value.trim();
    if (value) runPlayerAction(value);
  });
  document.querySelector("#lore-submit").addEventListener("click", addLoreDocument);
  document.querySelector("#growth-analyze").addEventListener("click", runGrowthAnalyze);
  document.querySelectorAll("[data-proposal-decision]").forEach((button) => {
    button.addEventListener("click", () => decideProposal(button.dataset.proposalId, button.dataset.proposalDecision));
  });
}

function renderHeroCard(hero) {
  return `
    <section>
      <h2>主角卡</h2>
      <div class="mini-card">
        <h3>${escapeHtml(hero.name)}</h3>
        <p class="small">${escapeHtml(hero.race.name)} · Lv${hero.level} · EXP ${hero.exp}</p>
        <p class="small">声望：${escapeHtml(hero.reputation || "无")}</p>
        <p class="small">状态：${escapeHtml((hero.status || []).join("，") || "无")}</p>
        <div class="section stat-table">
          ${Object.entries(hero.stats || {}).map(([key, value]) => `
            <div class="stat-pill"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderAbilities() {
  const items = appState.abilities || [];
  return `
    <section>
      <h2>能力</h2>
      <div class="list">
        ${items.length ? items.map((item) => `
          <div class="mini-card">
            <strong>${escapeHtml(item.name)}</strong>
            <p class="small">${escapeHtml(item.type || "能力")} · Lv${escapeHtml(item.level || 1)}</p>
            <p class="small">${escapeHtml(item.description || "")}</p>
          </div>
        `).join("") : `<div class="mini-card muted">暂无能力</div>`}
      </div>
    </section>
  `;
}

function renderInventory() {
  const items = appState.inventory || [];
  return `
    <section>
      <h2>物品</h2>
      <div class="tag-list">
        ${items.length ? items.map((item) => `<span class="tag">${escapeHtml(item.name || item)}</span>`).join("") : `<span class="tag">无特殊物品</span>`}
      </div>
    </section>
  `;
}

function renderOptionButton(option) {
  const action = `选择 ${option.id}：${option.title}。${option.description}`;
  return `
    <button class="option-btn" data-option="${escapeHtml(action)}">
      <strong>${escapeHtml(option.id)}. ${escapeHtml(option.title)}</strong>
      <span>${escapeHtml(option.description)}</span>
    </button>
  `;
}

function renderNpcCards() {
  const npcs = appState.npcs || [];
  if (!npcs.length) return `<div class="mini-card muted">尚未出现主要 NPC</div>`;
  return npcs.map((npc) => `
    <article class="npc-card">
      <h3>${escapeHtml(npc.name)}</h3>
      <p class="small">阵营：${escapeHtml(npc.faction || npc.stance || "未知")}</p>
      <p class="small">关系：${escapeHtml(npc.relationship || "未建立")} · 好感：${escapeHtml(npc.affinity ?? "未知")} · 信任：${escapeHtml(npc.trust ?? "未知")}</p>
      <p class="small">目标：${escapeHtml(npc.goal || "未知")}</p>
      <p class="small">精神状态：${escapeHtml(npc.mental_state || "未知")}</p>
    </article>
  `).join("");
}

function renderHistory() {
  const history = [...(appState.history || [])].reverse().slice(0, 20);
  if (!history.length) return `<div class="mini-card muted">暂无记录</div>`;
  return history.map((entry) => `
    <div class="mini-card">
      <strong>${escapeHtml(entry.title || `第 ${entry.turn} 轮`)}</strong>
      <p class="small">${escapeHtml(entry.text || "")}</p>
    </div>
  `).join("");
}

function renderSessionSummary() {
  if (!sessionSummary?.summary) return "暂无压缩会话记忆。";
  return `已压缩消息数：${sessionSummary.coveredMessageCount || 0}\n${sessionSummary.summary}`;
}

function renderGrowthProposals() {
  if (!growthProposals.length) return `<div class="mini-card muted">暂无自生长候选</div>`;
  return growthProposals.slice(0, 8).map((proposal) => `
    <article class="mini-card">
      <strong>${escapeHtml(proposal.title)}</strong>
      <p class="small">类型：${escapeHtml(proposal.type)} · 状态：${escapeHtml(proposal.status)} · 风险：${escapeHtml(proposal.risk)}</p>
      <p class="small">${escapeHtml(proposal.rationale)}</p>
      ${proposal.patchFile ? `<p class="small">补丁文件：${escapeHtml(proposal.patchFile)}</p>` : ""}
      ${proposal.status === "pending" ? `
        <div class="form-actions section">
          <button class="primary-btn" data-proposal-id="${escapeHtml(proposal.id)}" data-proposal-decision="accepted">接受</button>
          <button class="danger-btn" data-proposal-id="${escapeHtml(proposal.id)}" data-proposal-decision="rejected">拒绝</button>
        </div>
      ` : ""}
    </article>
  `).join("");
}

async function loadGrowthProposals() {
  try {
    const data = await request("/api/growth/proposals");
    growthProposals = data.proposals || [];
  } catch {
    growthProposals = [];
  }
}

async function runPlayerAction(action) {
  try {
    setBusy(true);
    const data = await request("/api/turn", {
      method: "POST",
      body: JSON.stringify({ action, provider: getProviderConfig() })
    });
    appState = data.state;
    sessionSummary = data.sessionSummary;
    growthDue = Boolean(data.growthDue);
    await loadGrowthProposals();
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function addLoreDocument() {
  const title = document.querySelector("#lore-title").value.trim();
  const tags = document.querySelector("#lore-tags").value.trim();
  const content = document.querySelector("#lore-content").value.trim();
  if (!title || !content) {
    showNotice("资料标题和内容不能为空。", true);
    return;
  }
  try {
    setBusy(true);
    await request("/api/lore", {
      method: "POST",
      body: JSON.stringify({ title, tags, content })
    });
    loreCount += 1;
    showNotice("资料已保存到项目资料库。");
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function runGrowthAnalyze() {
  try {
    setBusy(true);
    const data = await request("/api/growth/analyze", {
      method: "POST",
      body: JSON.stringify({ provider: getProviderConfig() })
    });
    growthProposals = data.proposals || [];
    growthDue = false;
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function decideProposal(id, decision) {
  try {
    setBusy(true);
    await request(`/api/growth/proposals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision })
    });
    await loadGrowthProposals();
    render();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    setBusy(false);
  }
}

function getProviderConfig() {
  return {
    mode: providerMode.value,
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    apiKey: apiKey.value.trim()
  };
}

function loadProviderSettings() {
  const raw = localStorage.getItem("rag-gm-provider");
  if (!raw) {
    providerMode.value = "mock";
    return;
  }
  const saved = JSON.parse(raw);
  providerMode.value = saved.mode || "mock";
  baseUrl.value = saved.baseUrl || "";
  model.value = saved.model || "";
  apiKey.value = saved.apiKey || "";
  saveKey.checked = Boolean(saved.saveKey);
}

function saveProviderSettings() {
  if (!saveKey.checked) {
    localStorage.removeItem("rag-gm-provider");
    return;
  }
  localStorage.setItem("rag-gm-provider", JSON.stringify({
    ...getProviderConfig(),
    saveKey: true
  }));
}

function getSelectedRace() {
  return rules.races.find((race) => race.id === selectedRaceId) || rules.races[0];
}

function getStatsFromInputs() {
  const stats = {};
  let sum = 0;
  document.querySelectorAll("[data-stat]").forEach((input) => {
    const value = Math.max(0, Number.parseInt(input.value || "0", 10));
    stats[input.dataset.stat] = value;
    sum += value;
  });
  return { stats, sum };
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function setBusy(value) {
  busy = value;
  document.body.classList.toggle("loading", busy);
}

function showNotice(message, error = false) {
  const notice = document.createElement("div");
  notice.className = `notice ${error ? "error" : ""}`;
  notice.textContent = message;
  root.prepend(notice);
  setTimeout(() => notice.remove(), 5000);
}

function toList(items) {
  if (!Array.isArray(items) || !items.length) return `<div class="mini-card muted">暂无</div>`;
  return items.map((item) => `<div class="mini-card">${escapeHtml(item)}</div>`).join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
