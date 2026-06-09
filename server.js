import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import { BaseChatMessageHistory } from "@langchain/core/chat_history";
import { Document } from "@langchain/core/documents";
import { AIMessage, HumanMessage, SystemMessage, mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from "@langchain/core/messages";
import { JsonOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const DEFAULT_SESSION_ID = "default";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const PROMPT_FILE = path.join(__dirname, "prompts", "gm-system.md");

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

ensureProjectFiles();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      return sendJson(res, {
        state: readJson(STATE_FILE),
        rules: readJson(RULES_FILE),
        memoryCount: readJson(MEMORY_FILE).length,
        sessionSummary: readSessionSummary(DEFAULT_SESSION_ID)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      return sendJson(res, {
        state: readJson(STATE_FILE),
        rules: readJson(RULES_FILE),
        memories: readJson(MEMORY_FILE)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/create-character") {
      const payload = await readBody(req);
      const result = createCharacter(payload);
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/turn") {
      const payload = await readBody(req);
      const result = await runTurn(payload);
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      writeJson(STATE_FILE, defaultState());
      writeJson(MEMORY_FILE, []);
      const { sessionDir } = getSessionPaths(DEFAULT_SESSION_ID);
      if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
      return sendJson(res, { ok: true, state: readJson(STATE_FILE) });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: error.message || "Server error" }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`Long Adventure RAG GM is running at http://localhost:${PORT}`);
});

function ensureProjectFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(path.join(__dirname, "prompts"), { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  if (!fs.existsSync(RULES_FILE)) writeJson(RULES_FILE, defaultRules());
  if (!fs.existsSync(STATE_FILE)) writeJson(STATE_FILE, defaultState());
  if (!fs.existsSync(MEMORY_FILE)) writeJson(MEMORY_FILE, []);
}

class FileChatMessageHistory extends BaseChatMessageHistory {
  constructor({ sessionId, storagePath }) {
    super();
    this.sessionId = sanitizeSessionId(sessionId || DEFAULT_SESSION_ID);
    this.storagePath = storagePath;
    this.sessionDir = path.join(this.storagePath, this.sessionId);
    this.filePath = path.join(this.sessionDir, "messages.json");
    fs.mkdirSync(this.sessionDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) writeJson(this.filePath, []);
  }

  async getMessages() {
    const storedMessages = readJson(this.filePath);
    return mapStoredMessagesToChatMessages(storedMessages);
  }

  async addMessage(message) {
    const messages = await this.getMessages();
    messages.push(message);
    writeJson(this.filePath, mapChatMessagesToStoredMessages(messages));
  }

  async clear() {
    writeJson(this.filePath, []);
  }
}

function getSessionPaths(sessionId = DEFAULT_SESSION_ID) {
  const safeId = sanitizeSessionId(sessionId);
  const sessionDir = path.join(SESSIONS_DIR, safeId);
  return {
    sessionId: safeId,
    sessionDir,
    messagesFile: path.join(sessionDir, "messages.json"),
    summaryFile: path.join(sessionDir, "summary.json")
  };
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || DEFAULT_SESSION_ID).replace(/[^\w.-]/g, "_").slice(0, 80) || DEFAULT_SESSION_ID;
}

function getChatHistory(sessionId = DEFAULT_SESSION_ID) {
  return new FileChatMessageHistory({ sessionId, storagePath: SESSIONS_DIR });
}

function readSessionSummary(sessionId = DEFAULT_SESSION_ID) {
  const { summaryFile, sessionDir } = getSessionPaths(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!fs.existsSync(summaryFile)) {
    writeJson(summaryFile, {
      sessionId: sanitizeSessionId(sessionId),
      updatedAt: null,
      coveredMessageCount: 0,
      summary: "暂无压缩会话记忆。"
    });
  }
  return readJson(summaryFile);
}

function writeSessionSummary(sessionId, summary) {
  const { summaryFile, sessionDir } = getSessionPaths(sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  writeJson(summaryFile, summary);
}

function defaultState() {
  return {
    version: 1,
    phase: "creation",
    turn: 0,
    hero: null,
    abilities: [],
    inventory: [],
    npcs: [],
    factions: [
      {
        id: "adventurers-guild",
        name: "冒险者公会",
        stance: "中立",
        goal: "维持委托秩序并拓展边境影响力",
        current_moves: ["招募新人", "调查边境魔物异动"]
      },
      {
        id: "silver-ash-kingdom",
        name: "银灰王国",
        stance: "区域政权",
        goal: "稳住王都与边境领的权力平衡",
        current_moves: ["征税", "整编地方守备队"]
      }
    ],
    world: {
      day: 1,
      location: "边境驿站外",
      time: "傍晚",
      active_events: [
        "边境道路出现异常魔兽踪迹",
        "冒险者公会正在招募低阶新人"
      ]
    },
    lastTurn: null,
    history: []
  };
}

function defaultRules() {
  return {
    stats: ["STR", "AGI", "VIT", "INT", "MEN", "MP"],
    level: {
      min: 1,
      max: 100,
      totalExpFormula: "10 * level^2",
      killExpFormula: "5 * target_level",
      questExpFormula: "10 * quest_level",
      bands: [
        { range: "Lv1-Lv29", label: "普通人" },
        { range: "Lv30-Lv49", label: "强者" },
        { range: "Lv50-Lv69", label: "传奇" },
        { range: "Lv70-Lv79", label: "历史巅峰" },
        { range: "Lv80+", label: "神话领域" }
      ]
    },
    races: [
      {
        id: "wolf-beastman",
        name: "兽人族 / Wolf Beastman",
        initial_points: 30,
        growth: { STR: 1.2, AGI: 1, VIT: 1.1, INT: 1, MEN: 0.9, MP: 1 },
        talent: {
          name: "野性直觉",
          description: "提升战斗预判、夜间感知和危险反应速度。"
        }
      },
      {
        id: "elf",
        name: "精灵族 / Elf",
        initial_points: 28,
        growth: { STR: 1, AGI: 1, VIT: 0.8, INT: 1.2, MEN: 1, MP: 1.3 },
        talent: {
          name: "自然共鸣",
          description: "提升魔法亲和、环境恢复和魔力流动感知。"
        }
      },
      {
        id: "dragon-blood",
        name: "龙族血裔 / Dragon Blood",
        initial_points: 25,
        growth: { STR: 1.1, AGI: 1.1, VIT: 1.1, INT: 1.1, MEN: 1.1, MP: 1.4 },
        talent: {
          name: "龙血觉醒",
          description: "可成长龙化能力，获得魔力压制抗性和恢复加速。"
        }
      },
      {
        id: "human",
        name: "人类 / Human",
        initial_points: 32,
        growth: { STR: 1, AGI: 1, VIT: 1, INT: 1, MEN: 1, MP: 1 },
        talent: {
          name: "适应者",
          description: "技能学习速度提升，装备兼容性最高。"
        }
      },
      {
        id: "demon",
        name: "魔族 / Demon",
        initial_points: 27,
        growth: { STR: 1, AGI: 1, VIT: 0.9, INT: 1, MEN: 1.2, MP: 1.5 },
        talent: {
          name: "深渊共鸣",
          description: "黑暗魔法强化，情绪波动可转化为魔力。"
        }
      }
    ],
    mainTalents: [
      { id: "none", name: "无神话级天赋", description: "保持普通起点，不获得世界唯一能力。" },
      {
        id: "contract-throne",
        name: "契约王座",
        description: "世界唯一神话级天赋。只能在信任、认可、救助、共患难、战胜对方或命运共鸣等条件满足后，与强大女性建立非强制契约。"
      }
    ],
    subTalents: [
      { id: "none", name: "不选择副天赋", description: "保留更普通的开局。" },
      { id: "infinite-growth", name: "无限成长", description: "突破常规等级上限的成长潜质。" },
      { id: "plunder-eye", name: "掠夺之眼", description: "可查看等级、属性、天赋、隐藏身份、好感度与契约条件。" },
      { id: "beast-king-bloodline", name: "兽王血脉", description: "强化肉体，并逐步获得统御魔兽的可能。" },
      { id: "fate-coin", name: "命运金币", description: "每日一次幸运事件，但幸运的形态不总是安全。" },
      { id: "valhalla", name: "英灵殿", description: "契约伙伴死亡后有机会保留灵魂。" },
      { id: "kingly-charm", name: "王之魅力", description: "更容易获得信任与支持，但不会扭曲他人核心价值观。" }
    ]
  };
}

function createCharacter(payload) {
  const rules = readJson(RULES_FILE);
  const state = readJson(STATE_FILE);
  if (state.phase !== "creation") throw new Error("角色已经创建。若要重开，请先重置存档。");

  const race = rules.races.find((item) => item.id === payload.raceId);
  if (!race) throw new Error("请选择有效种族。");

  const stats = {};
  let sum = 0;
  for (const key of rules.stats) {
    const value = Number(payload.stats?.[key] ?? 0);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} 必须是非负整数。`);
    stats[key] = value;
    sum += value;
  }
  if (sum !== race.initial_points) {
    throw new Error(`属性点必须刚好分配 ${race.initial_points} 点，当前为 ${sum} 点。`);
  }

  const mainTalent = rules.mainTalents.find((item) => item.id === payload.mainTalentId) || rules.mainTalents[0];
  const subTalent = rules.subTalents.find((item) => item.id === payload.subTalentId) || rules.subTalents[0];
  const heroName = String(payload.name || "未命名冒险者").trim().slice(0, 40);

  state.phase = "adventure";
  state.hero = {
    id: "hero",
    name: heroName,
    race: { id: race.id, name: race.name },
    level: 1,
    exp: 0,
    reputation: "无名新人",
    stats,
    growth: race.growth,
    status: ["健康", "尚未登记冒险者身份"],
    stance: "由玩家决定"
  };
  state.abilities = [
    { name: race.talent.name, type: "种族天赋", description: race.talent.description, level: 1 }
  ];
  if (mainTalent.id !== "none") {
    state.abilities.push({ name: mainTalent.name, type: "核心天赋", description: mainTalent.description, level: 1 });
  }
  if (subTalent.id !== "none") {
    state.abilities.push({ name: subTalent.name, type: "副天赋", description: subTalent.description, level: 1 });
  }
  state.inventory = [];
  state.lastTurn = initialTurn(heroName);
  state.history.push({
    turn: 0,
    title: "角色创建完成",
    text: `${heroName} 创建完成。种族：${race.name}。GM 尚未替玩家设定背景、立场或行动。`
  });

  writeJson(STATE_FILE, state);
  appendMemories([
    {
      type: "character",
      tags: ["hero", "creation", race.id],
      text: `主角 ${heroName} 创建完成。种族为 ${race.name}，属性为 ${JSON.stringify(stats)}。玩家尚未选择背景、立场和行动路线。`
    }
  ]);

  return { ok: true, state };
}

function initialTurn(heroName) {
  return {
    scene: `傍晚的边境驿站外，风从荒草坡上吹来，带着泥土、马汗和远处森林的潮湿气味。${heroName} 站在路牌旁，前方是通往公会的小路，另一侧则是已经开始昏暗的旧林道。世界不会等待任何人，商队、守备队和流言都在继续移动。`,
    reactions: [
      "驿站老板正在估量新来的陌生人是否会惹麻烦。",
      "一名披斗篷的公会记录员注意到了你，但还没有主动靠近。"
    ],
    hero_status: "Lv1，健康，未登记冒险者身份。",
    npc_cards: [],
    world_status: "边境道路出现异常魔兽踪迹，冒险者公会正在招募新人。",
    options: [
      { id: "A", title: "前往冒险者公会", description: "登记身份，了解低阶委托。" },
      { id: "B", title: "询问驿站老板", description: "打听附近道路、传闻和危险。" },
      { id: "C", title: "观察来往行人", description: "寻找值得注意的人或异常细节。" },
      { id: "D", title: "走向旧林道边缘", description: "在不深入的前提下查看魔兽踪迹。" }
    ],
    log: ["角色创建完成。", "玩家尚未作出第一个冒险选择。"]
  };
}

async function runTurn(payload) {
  const state = readJson(STATE_FILE);
  if (state.phase !== "adventure" || !state.hero) throw new Error("请先创建角色。");

  const action = String(payload.action || "").trim();
  if (!action) throw new Error("玩家行动不能为空。");
  const provider = payload.provider || {};
  const sessionId = sanitizeSessionId(payload.sessionId || DEFAULT_SESSION_ID);
  const chatHistory = getChatHistory(sessionId);
  const sessionSummary = readSessionSummary(sessionId);
  const memoryDocs = retrieveMemoryDocuments(action, state);
  const chainInput = buildLangChainInput(state, action, memoryDocs, sessionSummary);

  const turnResult = provider.mode === "mock"
    ? makeMockTurn(state, action, memoryDocs, sessionSummary)
    : await invokeGmChain(provider, chainInput);

  const normalized = normalizeTurnResult(turnResult);
  state.turn += 1;
  state.lastTurn = normalized;
  state.history.push({
    turn: state.turn,
    title: `第 ${state.turn} 轮`,
    text: [
      `玩家行动：${action}`,
      `结果：${normalized.log.join("；")}`
    ].join("\n")
  });
  if (normalized.state_patch && typeof normalized.state_patch === "object") {
    deepMergeAllowed(state, normalized.state_patch);
  }
  if (Array.isArray(normalized.npc_cards)) {
    mergeNpcCards(state, normalized.npc_cards);
  }
  appendMemories([
    {
      type: "turn",
      tags: ["turn", `turn-${state.turn}`],
      text: `第 ${state.turn} 轮。玩家行动：${action}。场景结果：${normalized.scene}。记录：${normalized.log.join("；")}`
    },
    ...normalized.memory_entries.map((entry) => ({
      type: entry.type || "note",
      tags: Array.isArray(entry.tags) ? entry.tags : ["gm-note"],
      text: String(entry.text || "").slice(0, 2000)
    })).filter((entry) => entry.text)
  ]);

  writeJson(STATE_FILE, state);
  await chatHistory.addMessages([
    new HumanMessage(action),
    new AIMessage(JSON.stringify(normalized))
  ]);
  await maybeCompressSessionHistory(provider, sessionId);

  return {
    ok: true,
    state,
    retrievedMemories: memoryDocs.map(documentToMemory),
    sessionSummary: readSessionSummary(sessionId)
  };
}

function buildLangChainInput(state, action, memoryDocs, sessionSummary) {
  const systemPrompt = fs.existsSync(PROMPT_FILE)
    ? fs.readFileSync(PROMPT_FILE, "utf8")
    : "你是长期冒险小说 GM。";

  const userPrompt = JSON.stringify({
    task: "根据玩家行动运行下一轮 GM 回合。只反馈结果，不替玩家决定下一步。",
    player_action: action,
    compressed_session_memory: sessionSummary.summary || "暂无压缩会话记忆。",
    current_state: state,
    retrieved_memories: formatDocuments(memoryDocs),
    required_output: {
      scene: "string，场景正文",
      reactions: ["string，即时反应，展示关键角色心理活动"],
      hero_status: "string，主角状态栏摘要",
      npc_cards: [
        {
          id: "stable-id",
          name: "string",
          appearance: "string",
          personality: "string",
          goal: "string",
          weakness: "string",
          secret: "string，可写未知或仅GM可见",
          stance: "string",
          affinity: "number or string",
          trust: "number or string",
          relationship: "string",
          faction: "string",
          mental_state: "string"
        }
      ],
      world_status: "string",
      options: [
        { id: "A", title: "string", description: "string" },
        { id: "B", title: "string", description: "string" },
        { id: "C", title: "string", description: "string" },
        { id: "D", title: "string", description: "string" }
      ],
      log: ["string，剧情记录"],
      state_patch: "object，可选，只写需要更新的主角、NPC、势力、世界变化",
      memory_entries: [
        { type: "npc|faction|world|relationship|plot|item|ability|note", tags: ["string"], text: "string" }
      ]
    },
    output_rule: "必须返回单个 JSON 对象，不要 Markdown，不要代码块。"
  }, null, 2);

  return { systemPrompt, userPrompt };
}

async function invokeGmChain(provider, chainInput) {
  if (!provider.apiKey) throw new Error("请先填写玩家自己的智能体 API Key，或切换到本地演示模式。");

  if (provider.mode === "custom-json") {
    return createCustomJsonAgentChain(provider).invoke(chainInput);
  }

  return createOpenAICompatibleGmChain(provider).invoke(chainInput);
}

function createOpenAICompatibleGmChain(provider) {
  const model = new ChatOpenAI({
    apiKey: provider.apiKey,
    model: provider.model || "gpt-4.1-mini",
    temperature: 0.8,
    configuration: {
      baseURL: normalizeOpenAIBaseURL(provider.baseUrl || "https://api.openai.com/v1")
    }
  });

  return RunnableSequence.from([
    RunnableLambda.from(({ systemPrompt, userPrompt }) => [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt)
    ]),
    model,
    new StringOutputParser(),
    tolerantJsonParser()
  ]);
}

function createCustomJsonAgentChain(provider) {
  if (!provider.baseUrl) throw new Error("请填写自定义智能体 API 地址。");
  return RunnableSequence.from([
    RunnableLambda.from(async (input) => {
      const response = await fetch(provider.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify({
          input: input.userPrompt,
          system: input.systemPrompt
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || data.message || `智能体请求失败：${response.status}`);
      return data.output || data.answer || data.text || data.message || data.content || data;
    }),
    tolerantJsonParser()
  ]);
}

function tolerantJsonParser() {
  const parser = new JsonOutputParser();
  return RunnableLambda.from(async (value) => {
    try {
      return await parser.invoke(value);
    } catch {
      return parseAgentContent(value);
    }
  });
}

function normalizeOpenAIBaseURL(baseUrl) {
  const clean = String(baseUrl).trim().replace(/\/+$/, "");
  if (clean.endsWith("/chat/completions")) return clean.replace(/\/chat\/completions$/, "");
  if (clean.endsWith("/v1")) return clean;
  return `${clean}/v1`;
}

function parseAgentContent(content) {
  if (typeof content === "object") return content;
  const text = String(content || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("智能体没有返回可解析的 JSON。请让智能体按系统提示返回单个 JSON 对象。");
  }
}

function normalizeTurnResult(raw) {
  const options = Array.isArray(raw.options) ? raw.options.slice(0, 8) : [];
  while (options.length < 4) {
    const id = String.fromCharCode(65 + options.length);
    options.push({ id, title: "谨慎观察", description: "暂不贸然行动，继续收集周围信息。" });
  }

  return {
    scene: String(raw.scene || "世界继续运行，但这一轮没有得到有效场景正文。"),
    reactions: toStringArray(raw.reactions),
    hero_status: String(raw.hero_status || ""),
    npc_cards: Array.isArray(raw.npc_cards) ? raw.npc_cards : [],
    world_status: String(raw.world_status || ""),
    options: options.map((item, index) => ({
      id: String(item.id || String.fromCharCode(65 + index)),
      title: String(item.title || `选项 ${index + 1}`),
      description: String(item.description || "")
    })),
    log: toStringArray(raw.log).length ? toStringArray(raw.log) : ["本轮已推进。"],
    state_patch: raw.state_patch && typeof raw.state_patch === "object" ? raw.state_patch : null,
    memory_entries: Array.isArray(raw.memory_entries) ? raw.memory_entries : []
  };
}

function makeMockTurn(state, action, memoryDocs, sessionSummary) {
  const day = state.world?.day || 1;
  const location = state.world?.location || "边境";
  return {
    scene: `你选择了：${action}。\n\n${location} 的空气仍在流动，远处的人声、车轮声和风声没有因为你的决定而停下。GM 会承认这次行动，但不会替你决定立场、语言或下一步。由于当前使用的是本地演示模式，这一轮只生成保守结果：你获得了更多可观察信息，世界事件继续推进。\n\n压缩会话记忆：${sessionSummary.summary}`,
    reactions: [
      "附近的陌生人注意到你的行动，但尚未判断你是否可信。",
      "公会相关的传闻仍在扩散，边境的不安没有消失。"
    ],
    hero_status: `${state.hero.name}：Lv${state.hero.level}，${state.hero.status.join("，")}。`,
    npc_cards: [],
    world_status: `第 ${day} 日，${location}。已检索 ${memoryDocs.length} 条相关记忆。`,
    options: [
      { id: "A", title: "继续追问", description: "围绕刚才获得的信息向附近人物打听。" },
      { id: "B", title: "保持距离观察", description: "不暴露意图，记录人物和环境变化。" },
      { id: "C", title: "前往公会", description: "寻找正式委托和登记机会。" },
      { id: "D", title: "离开人群", description: "转向道路或林地边缘，寻找实际痕迹。" }
    ],
    log: [
      "本地演示模式完成一轮推进。",
      "没有替玩家做决定。",
      "真实剧情建议配置玩家自己的智能体 API Key 后运行。"
    ],
    state_patch: {
      world: {
        day,
        location,
        time: state.world?.time || "傍晚"
      }
    },
    memory_entries: [
      {
        type: "plot",
        tags: ["mock", "player-action"],
        text: `玩家在演示模式下行动：${action}`
      }
    ]
  };
}

function retrieveMemoryDocuments(action, state) {
  const memories = readJson(MEMORY_FILE);
  const query = [
    action,
    state.hero?.name,
    state.world?.location,
    ...(state.npcs || []).map((npc) => npc.name),
    ...(state.factions || []).map((faction) => faction.name)
  ].filter(Boolean).join(" ");
  const queryTokens = tokenize(query);

  return memories
    .map((memory) => {
      const text = `${memory.text || ""} ${(memory.tags || []).join(" ")}`;
      const tokens = tokenize(text);
      const overlap = [...tokens].filter((token) => queryTokens.has(token)).length;
      const recency = Math.max(0, Number(memory.turn || 0)) / 1000;
      return { ...memory, score: overlap + recency };
    })
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ score, ...memory }) => new Document({
      pageContent: memory.text || "",
      metadata: {
        id: memory.id,
        type: memory.type,
        tags: memory.tags || [],
        turn: memory.turn,
        createdAt: memory.createdAt,
        importance: memory.importance,
        score
      }
    }));
}

function formatDocuments(documents) {
  if (!documents.length) return "无相关长期事实记忆。";
  return documents.map((doc, index) => {
    const tags = Array.isArray(doc.metadata.tags) ? doc.metadata.tags.join(",") : "";
    return `【记忆 ${index + 1}】type=${doc.metadata.type || "note"} turn=${doc.metadata.turn ?? "?"} tags=${tags}\n${doc.pageContent}`;
  }).join("\n\n");
}

function documentToMemory(doc) {
  return {
    id: doc.metadata.id,
    type: doc.metadata.type,
    tags: doc.metadata.tags,
    turn: doc.metadata.turn,
    createdAt: doc.metadata.createdAt,
    importance: doc.metadata.importance,
    text: doc.pageContent
  };
}

async function maybeCompressSessionHistory(provider, sessionId = DEFAULT_SESSION_ID) {
  const history = getChatHistory(sessionId);
  const messages = await history.getMessages();
  const currentSummary = readSessionSummary(sessionId);
  const coveredMessageCount = Number(currentSummary.coveredMessageCount || 0);
  const pendingMessages = messages.slice(coveredMessageCount);

  if (pendingMessages.length < 6) return;

  const summary = provider.mode === "mock"
    ? makeLocalSessionSummary(currentSummary.summary, pendingMessages)
    : await invokeSummaryChain(provider, currentSummary.summary, pendingMessages);

  writeSessionSummary(sessionId, {
    sessionId,
    updatedAt: new Date().toISOString(),
    coveredMessageCount: messages.length,
    summary
  });
}

async function invokeSummaryChain(provider, existingSummary, pendingMessages) {
  if (!provider.apiKey) return makeLocalSessionSummary(existingSummary, pendingMessages);
  if (provider.mode === "custom-json") {
    return invokeCustomJsonSummary(provider, existingSummary, pendingMessages);
  }

  const model = new ChatOpenAI({
    apiKey: provider.apiKey,
    model: provider.model || "gpt-4.1-mini",
    temperature: 0.2,
    configuration: {
      baseURL: normalizeOpenAIBaseURL(provider.baseUrl || "https://api.openai.com/v1")
    }
  });

  const chain = RunnableSequence.from([
    RunnableLambda.from(({ summary, messagesText }) => [
      new SystemMessage("你是长期冒险 RAG GM 的会话记忆压缩器。只压缩已经发生的事实，不添加新剧情，不替玩家决定。输出中文摘要，不要 Markdown。"),
      new HumanMessage(JSON.stringify({
        task: "更新长期会话摘要，用于后续 GM 回合减少 token。",
        keep: [
          "玩家已明确做出的选择",
          "GM 已裁定的后果",
          "NPC 关系、阵营、目标、秘密线索",
          "主角能力、物品、状态、声望、位置",
          "势力变化、世界事件、未解决冲突",
          "绝对禁止事项：不得替玩家行动或补写玩家未选择的立场"
        ],
        existing_summary: summary,
        new_messages: messagesText,
        length_limit: "尽量控制在 1200 中文字以内。"
      }, null, 2))
    ]),
    model,
    new StringOutputParser()
  ]);

  return (await chain.invoke({
    summary: existingSummary || "暂无压缩会话记忆。",
    messagesText: formatMessagesForSummary(pendingMessages)
  })).trim();
}

async function invokeCustomJsonSummary(provider, existingSummary, pendingMessages) {
  if (!provider.baseUrl) return makeLocalSessionSummary(existingSummary, pendingMessages);
  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      system: "你是长期冒险 RAG GM 的会话记忆压缩器。只压缩事实，不添加新剧情，不替玩家决定。输出中文摘要文本。",
      input: JSON.stringify({
        task: "更新长期会话摘要，用于后续 GM 回合减少 token。",
        existing_summary: existingSummary || "暂无压缩会话记忆。",
        new_messages: formatMessagesForSummary(pendingMessages),
        length_limit: "尽量控制在 1200 中文字以内。"
      }, null, 2)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return makeLocalSessionSummary(existingSummary, pendingMessages);
  const text = data.output || data.answer || data.text || data.message || data.content;
  return typeof text === "string" ? text.trim() : makeLocalSessionSummary(existingSummary, pendingMessages);
}

function makeLocalSessionSummary(existingSummary, pendingMessages) {
  const additions = pendingMessages
    .map((message) => {
      const role = message._getType?.() || "message";
      const text = messageContentToText(message.content);
      if (role === "human") return `玩家行动：${text}`;
      if (role === "ai") return `GM结果：${summarizeAiTurnText(text)}`;
      return `${role}：${text}`;
    })
    .join("\n")
    .slice(0, 1800);
  const base = existingSummary && existingSummary !== "暂无压缩会话记忆。" ? `${existingSummary}\n` : "";
  return `${base}${additions}`.slice(-2400) || "暂无压缩会话记忆。";
}

function summarizeAiTurnText(text) {
  try {
    const parsed = JSON.parse(text);
    const log = Array.isArray(parsed.log) ? parsed.log.join("；") : "";
    const world = parsed.world_status ? `世界：${parsed.world_status}` : "";
    return [log, world].filter(Boolean).join("。").slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function formatMessagesForSummary(messages) {
  return messages.map((message, index) => {
    const role = message._getType?.() || "message";
    return `【${index + 1} ${role}】${messageContentToText(message.content)}`;
  }).join("\n\n");
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

function tokenize(text) {
  const normalized = String(text).toLowerCase();
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) || [];
  const cjk = normalized.match(/[\u4e00-\u9fff]{1,2}/g) || [];
  return new Set([...latin, ...cjk]);
}

function appendMemories(entries) {
  const memories = readJson(MEMORY_FILE);
  const state = readJson(STATE_FILE);
  for (const entry of entries) {
    memories.push({
      id: crypto.randomUUID(),
      turn: state.turn || 0,
      createdAt: new Date().toISOString(),
      importance: entry.importance || 1,
      type: entry.type || "note",
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      text: String(entry.text || "")
    });
  }
  writeJson(MEMORY_FILE, memories);
}

function mergeNpcCards(state, cards) {
  state.npcs ||= [];
  for (const card of cards) {
    if (!card || !card.name) continue;
    const id = String(card.id || slugify(card.name));
    const existing = state.npcs.find((npc) => npc.id === id || npc.name === card.name);
    const normalized = { ...card, id };
    if (existing) Object.assign(existing, normalized);
    else state.npcs.push(normalized);
  }
}

function deepMergeAllowed(target, patch) {
  const allowed = new Set(["hero", "abilities", "inventory", "npcs", "factions", "world"]);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) continue;
    if (Array.isArray(value)) {
      target[key] = value;
    } else if (value && typeof value === "object" && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] ||= {};
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function toStringArray(value) {
  if (!Array.isArray(value)) return value ? [String(value)] : [];
  return value.map((item) => String(item)).filter(Boolean);
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || crypto.randomUUID();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function serveStatic(requestPath, res) {
  const pathname = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, { error: "Forbidden" }, 403);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, { error: "Not found" }, 404);
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(filePath).pipe(res);
}
