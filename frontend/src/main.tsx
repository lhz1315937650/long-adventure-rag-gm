import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  addLore,
  analyzeGrowth,
  createCharacter,
  decideGrowthProposal,
  exportData,
  getBootstrap,
  getGrowthProposals,
  resetGame,
  runTurn
} from "./api";
import { loadProviderSettings, saveProviderSettings, type StoredProviderConfig } from "./providerSettings";
import type {
  AgentContract,
  GameState,
  GrowthProposal,
  LastTurn,
  NpcCard,
  Race,
  Rules,
  SessionSummary,
  TurnOption
} from "./types";
import "./styles.css";

const statNames = ["STR", "AGI", "VIT", "INT", "MEN", "MP"];

function App() {
  const [state, setState] = useState<GameState | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);
  const [loreCount, setLoreCount] = useState(0);
  const [growthDue, setGrowthDue] = useState(false);
  const [growthProposals, setGrowthProposals] = useState<GrowthProposal[]>([]);
  const [agentContract, setAgentContract] = useState<AgentContract | null>(null);
  const [provider, setProvider] = useState<StoredProviderConfig>(() => loadProviderSettings());
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    saveProviderSettings(provider);
  }, [provider]);

  async function bootstrap() {
    try {
      const data = await getBootstrap();
      setState(data.state);
      setRules(data.rules);
      setSessionSummary(data.sessionSummary);
      setLoreCount(data.loreCount || 0);
      setGrowthDue(Boolean(data.growthDue));
      setAgentContract(data.agentContract || null);
      await refreshGrowthProposals();
    } catch (error) {
      showNotice(errorMessage(error), true);
    }
  }

  async function refreshGrowthProposals() {
    try {
      const data = await getGrowthProposals();
      setGrowthProposals(data.proposals || []);
    } catch {
      setGrowthProposals([]);
    }
  }

  function showNotice(text: string, error = false) {
    setNotice({ text, error });
    window.setTimeout(() => setNotice(null), 5000);
  }

  async function handleExport() {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `long-adventure-rag-gm-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleReset() {
    if (!confirm("确定要重置本地存档和记忆吗？")) return;
    const data = await resetGame();
    setState(data.state);
    setSessionSummary(null);
    setGrowthDue(false);
    await refreshGrowthProposals();
  }

  async function withBusy(task: () => Promise<void>) {
    try {
      setBusy(true);
      await task();
    } catch (error) {
      showNotice(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  }

  const worldLine = useMemo(() => {
    const world = state?.world || {};
    return `${world.location || "未知地点"} · ${world.time || "未知时间"} · 第 ${world.day || 1} 日`;
  }, [state]);

  return (
    <div className={`app ${busy ? "loading" : ""}`}>
      <header className="topbar">
        <div>
          <h1>长期冒险 RAG GM</h1>
          <p>{state ? worldLine : "本地世界运行中"}</p>
        </div>
        <div className="top-actions">
          <button className="ghost-btn" onClick={() => void handleExport()}>导出</button>
          <button className="danger-btn" onClick={() => void handleReset()}>重置</button>
        </div>
      </header>

      <ProviderPanel provider={provider} onChange={setProvider} />
      {notice ? <div className={`notice ${notice.error ? "error" : ""}`}>{notice.text}</div> : null}

      <main>
        {!state || !rules ? (
          <div className="notice">正在加载本地世界...</div>
        ) : state.phase === "creation" ? (
          <CharacterCreation
            rules={rules}
            onCreate={(payload) => withBusy(async () => {
              const data = await createCharacter(payload);
              setState(data.state);
            })}
          />
        ) : (
          <GameView
            state={state}
            sessionSummary={sessionSummary}
            loreCount={loreCount}
            growthDue={growthDue}
            growthProposals={growthProposals}
            agentContract={agentContract}
            onAction={(action) => withBusy(async () => {
              const data = await runTurn(action, provider);
              setState(data.state);
              setSessionSummary(data.sessionSummary);
              setGrowthDue(Boolean(data.growthDue));
              await refreshGrowthProposals();
            })}
            onAddLore={(payload) => withBusy(async () => {
              await addLore(payload);
              setLoreCount((count) => count + 1);
              showNotice("资料已保存到项目资料库。");
            })}
            onAnalyzeGrowth={() => withBusy(async () => {
              const data = await analyzeGrowth(provider);
              setGrowthProposals(data.proposals || []);
              setGrowthDue(false);
            })}
            onDecideProposal={(id, decision) => withBusy(async () => {
              await decideGrowthProposal(id, decision);
              await refreshGrowthProposals();
            })}
          />
        )}
      </main>
    </div>
  );
}

function ProviderPanel({
  provider,
  onChange
}: {
  provider: StoredProviderConfig;
  onChange: (provider: StoredProviderConfig) => void;
}) {
  const update = (patch: Partial<StoredProviderConfig>) => onChange({ ...provider, ...patch });
  return (
    <section className="settings-panel">
      <div className="field">
        <label htmlFor="provider-mode">智能体模式</label>
        <select id="provider-mode" value={provider.mode} onChange={(event) => update({ mode: event.target.value as StoredProviderConfig["mode"] })}>
          <option value="openai-compatible">OpenAI 兼容接口</option>
          <option value="custom-json">自定义 Agent JSON</option>
          <option value="mock">本地演示模式</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="base-url">API 地址</label>
        <input id="base-url" value={provider.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" />
      </div>
      <div className="field">
        <label htmlFor="model">模型 / Agent</label>
        <input id="model" value={provider.model} onChange={(event) => update({ model: event.target.value })} placeholder="gpt-4.1-mini 或你的 Agent 模型名" />
      </div>
      <div className="field">
        <label htmlFor="api-key">玩家 API Key</label>
        <input id="api-key" type="password" value={provider.apiKey} onChange={(event) => update({ apiKey: event.target.value })} autoComplete="off" placeholder="只发送给本地后端，不写入服务器文件" />
      </div>
      <label className="checkline">
        <input type="checkbox" checked={provider.saveKey} onChange={(event) => update({ saveKey: event.target.checked })} />
        <span>保存在此浏览器</span>
      </label>
    </section>
  );
}

function CharacterCreation({ rules, onCreate }: { rules: Rules; onCreate: (payload: unknown) => void }) {
  const [selectedRaceId, setSelectedRaceId] = useState(rules.races[0]?.id || "");
  const [name, setName] = useState("");
  const [stats, setStats] = useState<Record<string, number>>(() => Object.fromEntries(statNames.map((stat) => [stat, 0])));
  const [mainTalentId, setMainTalentId] = useState(rules.mainTalents[0]?.id || "none");
  const [subTalentId, setSubTalentId] = useState(rules.subTalents[0]?.id || "none");
  const race = rules.races.find((item) => item.id === selectedRaceId) || rules.races[0];
  const used = Object.values(stats).reduce((sum, value) => sum + value, 0);
  const remaining = race.initial_points - used;

  function randomAllocate() {
    const next = Object.fromEntries(statNames.map((stat) => [stat, 0]));
    const weights = statNames.map((stat) => Math.max(0.1, race.growth[stat] || 1));
    for (let point = 0; point < race.initial_points; point += 1) {
      const total = weights.reduce((sum, value) => sum + value, 0);
      let cursor = Math.random() * total;
      let chosen = statNames[0];
      for (let index = 0; index < statNames.length; index += 1) {
        cursor -= weights[index];
        if (cursor <= 0) {
          chosen = statNames[index];
          break;
        }
      }
      next[chosen] += 1;
    }
    setStats(next);
  }

  function clearStats() {
    setStats(Object.fromEntries(statNames.map((stat) => [stat, 0])));
  }

  return (
    <section className="creation-layout">
      <div className="notice">先创建角色。GM 只提供种族框架和数值规则，不预设背景、立场或成长路线。</div>
      <h2>角色创建</h2>
      <div className="creation-grid">
        {rules.races.map((item) => (
          <RaceCard key={item.id} race={item} selected={item.id === selectedRaceId} onSelect={() => setSelectedRaceId(item.id)} />
        ))}
      </div>
      <div className="creation-form">
        <div>
          <div className="field">
            <label htmlFor="hero-name">角色名</label>
            <input id="hero-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="输入玩家角色名" />
          </div>
          <div className="section">
            <div className="stat-toolbar">
              <div className="remaining" style={{ color: remaining === 0 ? "var(--accent-strong)" : "var(--rust)" }}>剩余属性点：{remaining}</div>
              <div className="form-actions">
                <button className="ghost-btn" type="button" onClick={randomAllocate}>随机分配</button>
                <button className="plain-btn" type="button" onClick={clearStats}>清空</button>
              </div>
            </div>
            <div className="stat-grid">
              {statNames.map((stat) => {
                const info = rules.statDescriptions?.[stat];
                return (
                <label className="stat-input" key={stat}>
                  <span>{stat} {info?.name ? `· ${info.name}` : ""}</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={stats[stat] || 0}
                    onChange={(event) => setStats({ ...stats, [stat]: Math.max(0, Number.parseInt(event.target.value || "0", 10)) })}
                  />
                  {info?.description ? <em>{info.description}</em> : null}
                </label>
                );
              })}
            </div>
          </div>
        </div>
        <div>
          <div className="field">
            <label htmlFor="main-talent">核心天赋</label>
            <select id="main-talent" value={mainTalentId} onChange={(event) => setMainTalentId(event.target.value)}>
              {rules.mainTalents.map((item) => <option key={item.id} value={item.id}>{item.name} - {item.description}</option>)}
            </select>
          </div>
          <div className="field section">
            <label htmlFor="sub-talent">副天赋</label>
            <select id="sub-talent" value={subTalentId} onChange={(event) => setSubTalentId(event.target.value)}>
              {rules.subTalents.map((item) => <option key={item.id} value={item.id}>{item.name} - {item.description}</option>)}
            </select>
          </div>
          <div className="form-actions section">
            <button className="primary-btn" onClick={() => onCreate({ name, raceId: selectedRaceId, stats, mainTalentId, subTalentId })}>创建角色</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function RaceCard({ race, selected, onSelect }: { race: Race; selected: boolean; onSelect: () => void }) {
  const growth = Object.entries(race.growth).map(([key, value]) => `${key} x${value}`).join(" · ");
  return (
    <article className={`race-card ${selected ? "selected" : ""}`}>
      <h3>{race.name}</h3>
      <p className="small">初始属性点：{race.initial_points}</p>
      <p className="small">成长：{growth}</p>
      <p className="small">天赋：{race.talent.name}，{race.talent.description}</p>
      {race.talent.effects?.length ? <p className="small">效果：{race.talent.effects.join("；")}</p> : null}
      <button className="plain-btn" onClick={onSelect}>{selected ? "已选择" : "选择"}</button>
    </article>
  );
}

function GameView({
  state,
  sessionSummary,
  loreCount,
  growthDue,
  growthProposals,
  agentContract,
  onAction,
  onAddLore,
  onAnalyzeGrowth,
  onDecideProposal
}: {
  state: GameState;
  sessionSummary: SessionSummary | null;
  loreCount: number;
  growthDue: boolean;
  growthProposals: GrowthProposal[];
  agentContract: AgentContract | null;
  onAction: (action: string) => void;
  onAddLore: (payload: { title: string; tags: string; content: string }) => void;
  onAnalyzeGrowth: () => void;
  onDecideProposal: (id: string, decision: "accepted" | "rejected") => void;
}) {
  const [customAction, setCustomAction] = useState("");
  const last = state.lastTurn || {};
  if (!state.hero) return <div className="notice error">角色状态缺失，请重置后重新创建。</div>;
  return (
    <section className="game-layout">
      <aside className="side">
        <HeroCard state={state} />
        <Abilities state={state} />
        <Inventory state={state} />
      </aside>
      <section className="scene-panel">
        <h2>场景正文</h2>
        <TypewriterText text={last.scene || "等待 GM 回合。"} />
        <InfoSection title="即时反应" items={last.reactions} />
        <div className="section">
          <h3>可选行动</h3>
          <div className="option-grid">
            {(last.options || []).map((option) => <OptionButton key={option.id} option={option} onAction={onAction} />)}
          </div>
        </div>
        <div className="section custom-action">
          <h3>自定义行动</h3>
          <textarea value={customAction} onChange={(event) => setCustomAction(event.target.value)} placeholder="输入玩家自己的行动。GM 只裁定后果，不替玩家决定。" />
          <button className="primary-btn" onClick={() => {
            const value = customAction.trim();
            if (value) {
              onAction(value);
              setCustomAction("");
            }
          }}>提交行动</button>
        </div>
      </section>
      <aside className="right">
        <NpcPanel npcs={state.npcs || []} />
        <section>
          <h2>世界状态</h2>
          <div className="mini-card">{last.world_status || "暂无"}</div>
        </section>
        <section>
          <h2>剧情记录</h2>
          <div className="history-list"><History state={state} /></div>
        </section>
        <section>
          <h2>会话记忆</h2>
          <div className="mini-card small">{renderSessionSummary(sessionSummary)}</div>
        </section>
        <LorePanel loreCount={loreCount} onAddLore={onAddLore} />
        <GrowthPanel growthDue={growthDue} proposals={growthProposals} onAnalyze={onAnalyzeGrowth} onDecide={onDecideProposal} />
        <AgentPanel agentContract={agentContract} />
      </aside>
    </section>
  );
}

function TypewriterText({ text }: { text: string }) {
  const [visible, setVisible] = useState("");

  useEffect(() => {
    setVisible("");
    let index = 0;
    const timer = window.setInterval(() => {
      index = Math.min(text.length, index + 3);
      setVisible(text.slice(0, index));
      if (index >= text.length) window.clearInterval(timer);
    }, 18);
    return () => window.clearInterval(timer);
  }, [text]);

  return (
    <div className="scene-text" aria-live="polite">
      {visible}
      {visible.length < text.length ? <span className="stream-cursor" aria-hidden="true" /> : null}
    </div>
  );
}

function HeroCard({ state }: { state: GameState }) {
  const hero = state.hero!;
  return (
    <section>
      <h2>主角卡</h2>
      <div className="mini-card">
        <h3>{hero.name}</h3>
        <p className="small">{hero.race.name} · Lv{hero.level} · EXP {hero.exp}</p>
        <p className="small">声望：{hero.reputation || "无"}</p>
        <p className="small">状态：{(hero.status || []).join("，") || "无"}</p>
        <div className="section stat-table">
          {Object.entries(hero.stats || {}).map(([key, value]) => (
            <div className="stat-pill" key={key}><span>{key}</span><strong>{value}</strong></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Abilities({ state }: { state: GameState }) {
  const items = state.abilities || [];
  return (
    <section>
      <h2>能力</h2>
      <div className="list">
        {items.length ? items.map((item) => (
          <div className="mini-card" key={`${item.name}-${item.type}`}>
            <strong>{item.name}</strong>
            <p className="small">{item.type || "能力"} · Lv{item.level || 1}</p>
            <p className="small">{item.description || ""}</p>
          </div>
        )) : <div className="mini-card muted">暂无能力</div>}
      </div>
    </section>
  );
}

function Inventory({ state }: { state: GameState }) {
  const items = state.inventory || [];
  return (
    <section>
      <h2>物品</h2>
      <div className="tag-list">
        {items.length ? items.map((item, index) => <span className="tag" key={index}>{typeof item === "string" ? item : item.name}</span>) : <span className="tag">无特殊物品</span>}
      </div>
    </section>
  );
}

function OptionButton({ option, onAction }: { option: TurnOption; onAction: (action: string) => void }) {
  const action = `选择 ${option.id}：${option.title}。${option.description}`;
  return (
    <button className="option-btn" onClick={() => onAction(action)}>
      <strong>{option.id}. {option.title}</strong>
      <span>{option.description}</span>
    </button>
  );
}

function InfoSection({ title, items }: { title: string; items?: string[] }) {
  return (
    <div className="section">
      <h3>{title}</h3>
      <div className="list">
        {items?.length ? items.map((item, index) => <div className="mini-card" key={index}>{item}</div>) : <div className="mini-card muted">暂无</div>}
      </div>
    </div>
  );
}

function NpcPanel({ npcs }: { npcs: NpcCard[] }) {
  return (
    <section>
      <h2>主要角色</h2>
      <div className="list">
        {npcs.length ? npcs.map((npc) => (
          <article className="npc-card" key={npc.id || npc.name}>
            <h3>{npc.name}</h3>
            <p className="small">阵营：{npc.faction || npc.stance || "未知"}</p>
            <p className="small">关系：{npc.relationship || "未建立"} · 好感：{npc.affinity ?? "未知"} · 信任：{npc.trust ?? "未知"}</p>
            <p className="small">目标：{npc.goal || "未知"}</p>
            <p className="small">精神状态：{npc.mental_state || "未知"}</p>
          </article>
        )) : <div className="mini-card muted">尚未出现主要 NPC</div>}
      </div>
    </section>
  );
}

function History({ state }: { state: GameState }) {
  const history = [...(state.history || [])].reverse().slice(0, 20);
  if (!history.length) return <div className="mini-card muted">暂无记录</div>;
  return history.map((entry) => (
    <div className="mini-card" key={`${entry.turn}-${entry.title}`}>
      <strong>{entry.title || `第 ${entry.turn} 轮`}</strong>
      <p className="small">{entry.text || ""}</p>
    </div>
  ));
}

function LorePanel({ loreCount, onAddLore }: { loreCount: number; onAddLore: (payload: { title: string; tags: string; content: string }) => void }) {
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  return (
    <section>
      <h2>资料库</h2>
      <div className="mini-card small">已收录 {loreCount} 份资料。</div>
      <div className="custom-action section">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="资料标题" />
        <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" />
        <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="追加新的故事背景、势力、历史或设定。" />
        <button className="ghost-btn" onClick={() => {
          if (!title.trim() || !content.trim()) return;
          onAddLore({ title: title.trim(), tags: tags.trim(), content: content.trim() });
          setTitle("");
          setTags("");
          setContent("");
        }}>保存资料</button>
      </div>
    </section>
  );
}

function GrowthPanel({
  growthDue,
  proposals,
  onAnalyze,
  onDecide
}: {
  growthDue: boolean;
  proposals: GrowthProposal[];
  onAnalyze: () => void;
  onDecide: (id: string, decision: "accepted" | "rejected") => void;
}) {
  return (
    <section>
      <h2>自生长</h2>
      {growthDue ? <div className="notice">当前存档已达到建议审计阈值。</div> : null}
      <button className="ghost-btn" onClick={onAnalyze}>运行自生长审计</button>
      <div className="list section">
        {proposals.length ? proposals.slice(0, 8).map((proposal) => (
          <article className="mini-card" key={proposal.id}>
            <strong>{proposal.title}</strong>
            <p className="small">类型：{proposal.type} · 状态：{proposal.status} · 风险：{proposal.risk}</p>
            <p className="small">{proposal.rationale}</p>
            {proposal.patchFile ? <p className="small">补丁文件：{proposal.patchFile}</p> : null}
            {proposal.status === "pending" ? (
              <div className="form-actions section">
                <button className="primary-btn" onClick={() => onDecide(proposal.id, "accepted")}>接受</button>
                <button className="danger-btn" onClick={() => onDecide(proposal.id, "rejected")}>拒绝</button>
              </div>
            ) : null}
          </article>
        )) : <div className="mini-card muted">暂无自生长候选</div>}
      </div>
    </section>
  );
}

function AgentPanel({ agentContract }: { agentContract: AgentContract | null }) {
  const agents = agentContract?.agents || [];
  return (
    <section>
      <h2>代理系统</h2>
      <div className="list">
        {agents.length ? agents.map((agent) => (
          <article className="mini-card" key={agent.id}>
            <strong>{agent.name}</strong>
            <p className="small">{agent.role}</p>
            <p className="small">{agent.responsibilities.slice(0, 3).join("；")}</p>
          </article>
        )) : <div className="mini-card muted">未加载代理契约</div>}
      </div>
    </section>
  );
}

function renderSessionSummary(summary: SessionSummary | null) {
  if (!summary?.summary) return "暂无压缩会话记忆。";
  return `已压缩消息数：${summary.coveredMessageCount || 0}\n${summary.summary}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
