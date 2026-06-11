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
const FRONTEND_DIST_DIR = path.join(__dirname, "frontend", "dist");
const LORE_DIR = path.join(__dirname, "lore");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const GROWTH_DIR = path.join(DATA_DIR, "growth");
const PROPOSALS_DIR = path.join(GROWTH_DIR, "proposals");
const DEFAULT_SESSION_ID = "default";
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");
const RAG_INDEX_FILE = path.join(DATA_DIR, "rag-index.json");
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const PROMPT_FILE = path.join(__dirname, "prompts", "gm-system.md");
const AGENTS_FILE = path.join(__dirname, "agents", "novel-gm-agents.json");
const RAG_VECTOR_DIMENSIONS = 256;

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
        loreCount: listLoreDocuments().length,
        ragIndex: getRagIndexStatus(readJson(STATE_FILE), readSessionSummary(DEFAULT_SESSION_ID)),
        agentContract: readAgentContract(),
        growthDue: isGrowthAuditDue(readJson(STATE_FILE), readSessionSummary(DEFAULT_SESSION_ID)),
        sessionSummary: readSessionSummary(DEFAULT_SESSION_ID)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      return sendJson(res, { ok: true, contract: readAgentContract() });
    }

    if (req.method === "GET" && url.pathname === "/api/lore") {
      return sendJson(res, { ok: true, documents: listLoreDocuments() });
    }

    if (req.method === "POST" && url.pathname === "/api/lore") {
      const payload = await readBody(req);
      const document = createLoreDocument(payload);
      return sendJson(res, { ok: true, document });
    }

    if (req.method === "GET" && url.pathname === "/api/rag/status") {
      return sendJson(res, { ok: true, index: getRagIndexStatus(readJson(STATE_FILE), readSessionSummary(DEFAULT_SESSION_ID)) });
    }

    if (req.method === "POST" && url.pathname === "/api/rag/rebuild") {
      const index = buildRagIndex(readJson(STATE_FILE), readSessionSummary(DEFAULT_SESSION_ID));
      return sendJson(res, { ok: true, index: summarizeRagIndex(index) });
    }

    if (req.method === "GET" && url.pathname === "/api/export") {
      return sendJson(res, {
        state: readJson(STATE_FILE),
        rules: readJson(RULES_FILE),
        memories: readJson(MEMORY_FILE),
        lore: listLoreDocuments(),
        agentContract: readAgentContract(),
        growthProposals: listGrowthProposals()
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

    if (req.method === "POST" && url.pathname === "/api/provider/test") {
      const payload = await readBody(req);
      const result = await testProviderConnection(payload.provider || {});
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/growth/analyze") {
      const payload = await readBody(req);
      const result = await analyzeGrowth(payload);
      return sendJson(res, result);
    }

    if (req.method === "GET" && url.pathname === "/api/growth/proposals") {
      return sendJson(res, { ok: true, proposals: listGrowthProposals() });
    }

    const proposalDecisionMatch = url.pathname.match(/^\/api\/growth\/proposals\/([^/]+)\/decision$/);
    if (req.method === "POST" && proposalDecisionMatch) {
      const payload = await readBody(req);
      const result = decideGrowthProposal(proposalDecisionMatch[1], payload);
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
  fs.mkdirSync(LORE_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  fs.mkdirSync(path.join(__dirname, "prompts"), { recursive: true });

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

function readAgentContract() {
  if (!fs.existsSync(AGENTS_FILE)) {
    return {
      version: "missing",
      systemName: "未配置 Agent 系统",
      globalInvariants: [],
      agents: [],
      routing: []
    };
  }
  return readJson(AGENTS_FILE);
}

function getAgentById(id) {
  return readAgentContract().agents.find((agent) => agent.id === id) || null;
}

function listLoreDocuments() {
  fs.mkdirSync(LORE_DIR, { recursive: true });
  return walkFiles(LORE_DIR)
    .filter((file) => file.toLowerCase().endsWith(".md"))
    .map((file) => {
      const content = fs.readFileSync(file, "utf8");
      const relativePath = path.relative(__dirname, file).replaceAll("\\", "/");
      return {
        id: relativePath,
        title: extractMarkdownTitle(content) || path.basename(file, ".md"),
        path: relativePath,
        tags: extractMarkdownTags(content),
        updatedAt: fs.statSync(file).mtime.toISOString(),
        content
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path, "zh-Hans-CN"));
}

function createLoreDocument(payload) {
  const title = String(payload.title || "").trim();
  const content = String(payload.content || "").trim();
  const tags = Array.isArray(payload.tags)
    ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(payload.tags || "").split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean);

  if (!title) throw new Error("资料标题不能为空。");
  if (!content) throw new Error("资料内容不能为空。");

  const date = new Date().toISOString().slice(0, 10);
  const fileName = `${date}-${slugify(title)}.md`;
  const filePath = uniqueFilePath(path.join(LORE_DIR, fileName));
  const markdown = [
    `# ${title}`,
    "",
    `标签：${tags.length ? tags.join("，") : "未分类"}`,
    "",
    content,
    ""
  ].join("\n");

  fs.writeFileSync(filePath, markdown, "utf8");
  return listLoreDocuments().find((doc) => doc.path === path.relative(__dirname, filePath).replaceAll("\\", "/"));
}

function extractMarkdownTitle(content) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || "";
}

function extractMarkdownTags(content) {
  const match = content.match(/^标签[:：]\s*(.+)$/m);
  if (!match) return [];
  return match[1].split(/[，,\s]+/).map((tag) => tag.trim()).filter(Boolean);
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let index = 2;
  while (fs.existsSync(`${base}-${index}${ext}`)) index += 1;
  return `${base}-${index}${ext}`;
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function listGrowthProposals() {
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  return fs.readdirSync(PROPOSALS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => readJson(path.join(PROPOSALS_DIR, file)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function saveGrowthProposal(proposal) {
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  const normalized = normalizeGrowthProposal(proposal);
  writeJson(path.join(PROPOSALS_DIR, `${normalized.id}.json`), normalized);
  return normalized;
}

function normalizeGrowthProposal(proposal) {
  const typeAllowlist = new Set(["prompt_patch", "rules_patch", "lore_gap", "consistency_warning"]);
  const id = proposal.id ? sanitizeSessionId(proposal.id) : crypto.randomUUID();
  return {
    id,
    type: typeAllowlist.has(proposal.type) ? proposal.type : "consistency_warning",
    title: String(proposal.title || "未命名自生长建议").slice(0, 120),
    rationale: String(proposal.rationale || "未提供原因。").slice(0, 3000),
    risk: String(proposal.risk || "medium").slice(0, 80),
    target_files: Array.isArray(proposal.target_files) ? proposal.target_files.map(String) : [],
    patch: String(proposal.patch || "").slice(0, 12000),
    status: ["pending", "accepted", "rejected"].includes(proposal.status) ? proposal.status : "pending",
    createdAt: proposal.createdAt || new Date().toISOString(),
    decidedAt: proposal.decidedAt || null,
    decisionNote: proposal.decisionNote || "",
    patchFile: proposal.patchFile || null
  };
}

function decideGrowthProposal(id, payload) {
  const safeId = sanitizeSessionId(id);
  const filePath = path.join(PROPOSALS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) throw new Error("找不到这条自生长候选。");

  const decision = String(payload.decision || "").trim();
  if (!["accepted", "rejected"].includes(decision)) throw new Error("decision 必须是 accepted 或 rejected。");

  const proposal = readJson(filePath);
  proposal.status = decision;
  proposal.decidedAt = new Date().toISOString();
  proposal.decisionNote = String(payload.note || "");

  if (decision === "accepted") {
    const patchPath = path.join(PROPOSALS_DIR, `${safeId}.patch.md`);
    const patchText = [
      `# 自生长补丁建议：${proposal.title}`,
      "",
      `状态：accepted`,
      `类型：${proposal.type}`,
      `目标文件：${(proposal.target_files || []).join("，") || "未指定"}`,
      "",
      "## 原因",
      "",
      proposal.rationale || "无",
      "",
      "## 补丁/建议内容",
      "",
      proposal.patch || "无",
      ""
    ].join("\n");
    fs.writeFileSync(patchPath, patchText, "utf8");
    proposal.patchFile = path.relative(__dirname, patchPath).replaceAll("\\", "/");
  }

  writeJson(filePath, normalizeGrowthProposal(proposal));
  return { ok: true, proposal: readJson(filePath) };
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
    statDescriptions: {
      STR: { name: "力量", description: "影响近战攻击、负重、破坏障碍和力量对抗。" },
      AGI: { name: "敏捷", description: "影响闪避、先手、潜行、攀爬、射击和反应速度。" },
      VIT: { name: "体质", description: "影响生命力、抗打击、抗毒、耐力和伤势恢复。" },
      INT: { name: "智力", description: "影响知识、推理、魔法理解、语言和复杂工具使用。" },
      MEN: { name: "精神", description: "影响意志、感知、抗恐惧、契约稳定和精神魔法抵抗。" },
      MP: { name: "魔力", description: "影响施法强度、魔力量、魔法感知和魔导器适配。" }
    },
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
          description: "提升战斗预判、夜间感知和危险反应速度。",
          effects: ["夜间与低光环境感知提升", "遭遇伏击时更容易提前察觉", "追踪气味、脚印和血迹时获得优势"]
        }
      },
      {
        id: "elf",
        name: "精灵族 / Elf",
        initial_points: 28,
        growth: { STR: 1, AGI: 1, VIT: 0.8, INT: 1.2, MEN: 1, MP: 1.3 },
        talent: {
          name: "自然共鸣",
          description: "提升魔法亲和、环境恢复和魔力流动感知。",
          effects: ["在森林、河流、草地等自然环境中恢复更快", "更容易察觉魔力流动和自然异常", "自然魔法与精灵遗迹互动获得优势"]
        }
      },
      {
        id: "dragon-blood",
        name: "龙族血裔 / Dragon Blood",
        initial_points: 25,
        growth: { STR: 1.1, AGI: 1.1, VIT: 1.1, INT: 1.1, MEN: 1.1, MP: 1.4 },
        talent: {
          name: "龙血觉醒",
          description: "可成长龙化能力，获得魔力压制抗性和恢复加速。",
          effects: ["对威压、恐惧和魔力压制有额外抗性", "受伤后恢复速度略有提升", "后续可通过事件解锁龙化阶段"]
        }
      },
      {
        id: "human",
        name: "人类 / Human",
        initial_points: 32,
        growth: { STR: 1, AGI: 1, VIT: 1, INT: 1, MEN: 1, MP: 1 },
        talent: {
          name: "适应者",
          description: "技能学习速度提升，装备兼容性最高。",
          effects: ["学习新技能和工具时更快上手", "跨职业训练惩罚更低", "更容易适应不同种族装备和战斗风格"]
        }
      },
      {
        id: "demon",
        name: "魔族 / Demon",
        initial_points: 27,
        growth: { STR: 1, AGI: 1, VIT: 0.9, INT: 1, MEN: 1.2, MP: 1.5 },
        talent: {
          name: "深渊共鸣",
          description: "黑暗魔法强化，情绪波动可转化为魔力。",
          effects: ["黑暗、诅咒、深渊类魔法亲和提升", "强烈情绪可短暂转化为魔力爆发", "在魔域边缘更容易感知异常规则"]
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
  const memoryDocs = retrieveContextDocuments(action, state, sessionSummary);
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
    sessionSummary: readSessionSummary(sessionId),
    growthDue: isGrowthAuditDue(state, readSessionSummary(sessionId))
  };
}

function buildLangChainInput(state, action, memoryDocs, sessionSummary) {
  const systemPrompt = fs.existsSync(PROMPT_FILE)
    ? fs.readFileSync(PROMPT_FILE, "utf8")
    : "你是长期冒险小说 GM。";

  const userPrompt = JSON.stringify({
    active_agent: getAgentById("gm-narrator"),
    generation_mode: "real_agent_text_generation",
    task: "你必须作为真实 AI 智能体运行下一轮长期冒险小说 GM 回合，而不是复用本地演示模板。只反馈玩家行动造成的世界结果，不替玩家决定下一步。",
    role_contract: {
      novelist: {
        identity: "沉浸式异世界小说作家",
        duties: [
          "用中文小说正文描写环境、人物、事件、冲突和氛围。",
          "让文字具有连续的叙事推进，而不是机械系统播报。",
          "根据资料库和当前状态临场创作细节，但不得违背已确认事实。"
        ]
      },
      system_gm: {
        identity: "长期剧情系统 GM 与世界运行管理者",
        duties: [
          "裁定玩家行动的合理后果。",
          "运行 NPC 独立反应、势力变化、时间地点变化和风险。",
          "维护主角状态、NPC 关系、世界状态、剧情记录和长期记忆。",
          "提供至少 4 个差异明显的下一步选项，并允许玩家自定义行动。"
        ]
      },
      hard_limits: [
        "绝不替玩家说话。",
        "绝不替玩家决定立场、行动、承诺、购买、攻击、逃跑或契约。",
        "绝不把选项写成已经发生的结果。",
        "绝不因为主角身份豁免代价。"
      ]
    },
    player_action: action,
    compressed_session_memory: sessionSummary.summary || "暂无压缩会话记忆。",
    current_state: state,
    retrieved_memories: formatDocuments(memoryDocs),
    narrative_requirements: [
      "scene 必须是本轮新生成的中文小说正文，建议 500-1200 字，除非事件很短。",
      "scene 要承接 player_action，明确写出世界、NPC、环境和冲突如何响应。",
      "reactions 展示关键角色心理和态度变化，但不要泄露玩家无法合理知道的秘密。",
      "log 只记录本轮事实、线索、关系变化和世界变化，供长期记忆使用。",
      "state_patch 只写确实发生变化的结构化状态，不要大面积重写无关状态。"
    ],
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
  if (!provider.apiKey) throw new Error("真实智能体生成需要填写玩家自己的 API Key。本地演示模式只用于测试界面流程，不是真正 AI 文本生成。");

  if (provider.mode === "custom-json") {
    return createCustomJsonAgentChain(provider).invoke(chainInput);
  }

  return createOpenAICompatibleGmChain(provider).invoke(chainInput);
}

async function testProviderConnection(provider) {
  if (provider.mode === "mock") {
    return {
      ok: true,
      message: "本地演示模式可用，但它不是 AI 文本生成。"
    };
  }

  if (!provider.apiKey) throw new Error("请先填写玩家自己的 API Key。");

  if (provider.mode === "custom-json") {
    if (!provider.baseUrl) throw new Error("请填写自定义 Agent API 地址。");
    const response = await fetch(provider.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${provider.apiKey}`
      },
      body: JSON.stringify({
        system: "你是连接测试助手。只返回一句简短中文。",
        input: "请回复：连接成功。"
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || data.message || `智能体连接失败：${response.status}`);
    return {
      ok: true,
      message: "自定义 Agent 已响应。",
      sample: String(data.output || data.answer || data.text || data.message || data.content || JSON.stringify(data)).slice(0, 300)
    };
  }

  const model = new ChatOpenAI({
    apiKey: provider.apiKey,
    model: provider.model || "gpt-4.1-mini",
    temperature: 0,
    configuration: {
      baseURL: normalizeOpenAIBaseURL(provider.baseUrl || "https://api.openai.com/v1")
    }
  });

  const result = await model.invoke([
    new SystemMessage("你是连接测试助手。只返回一句简短中文。"),
    new HumanMessage("请回复：连接成功。")
  ]);

  return {
    ok: true,
    message: "真实智能体连接成功。",
    sample: String(result.content || "").slice(0, 300)
  };
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
  validateTurnResultShape(raw);
  const options = raw.options.slice(0, 8);

  return {
    scene: String(raw.scene).trim(),
    reactions: toStringArray(raw.reactions),
    hero_status: String(raw.hero_status || ""),
    npc_cards: Array.isArray(raw.npc_cards) ? raw.npc_cards : [],
    world_status: String(raw.world_status || ""),
    options: options.map((item, index) => ({
      id: String(item.id || String.fromCharCode(65 + index)),
      title: String(item.title || `选项 ${index + 1}`).trim(),
      description: String(item.description || "").trim()
    })),
    log: toStringArray(raw.log).length ? toStringArray(raw.log) : ["本轮已推进。"],
    state_patch: raw.state_patch && typeof raw.state_patch === "object" ? raw.state_patch : null,
    memory_entries: Array.isArray(raw.memory_entries) ? raw.memory_entries : []
  };
}

function validateTurnResultShape(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("智能体返回值必须是 JSON 对象。");
  }

  if (typeof raw.scene !== "string" || raw.scene.trim().length < 20) {
    throw new Error("智能体返回的 scene 过短或缺失。请让模型输出本轮新生成的小说正文。");
  }

  if (!Array.isArray(raw.options) || raw.options.length < 4) {
    throw new Error("智能体必须返回至少 4 个可选行动。");
  }

  for (const [index, option] of raw.options.entries()) {
    if (!option || typeof option !== "object") {
      throw new Error(`第 ${index + 1} 个选项不是对象。`);
    }
    if (!String(option.title || "").trim()) {
      throw new Error(`第 ${index + 1} 个选项缺少 title。`);
    }
    if (!String(option.description || "").trim()) {
      throw new Error(`第 ${index + 1} 个选项缺少 description。`);
    }
  }

  if (raw.memory_entries && !Array.isArray(raw.memory_entries)) {
    throw new Error("memory_entries 必须是数组。");
  }

  if (raw.npc_cards && !Array.isArray(raw.npc_cards)) {
    throw new Error("npc_cards 必须是数组。");
  }
}

function makeMockTurn(state, action, memoryDocs) {
  const day = state.world?.day || 1;
  const turn = (state.turn || 0) + 1;
  const hero = state.hero || { name: "玩家角色", level: 1, status: ["健康"] };
  const intent = detectMockIntent(action);
  const time = advanceMockTime(state.world?.time, turn);
  const branch = buildMockBranch(intent, { state, action, memoryDocs, day, turn, hero, time });

  return {
    scene: branch.scene,
    reactions: branch.reactions,
    hero_status: hero.name + "，Lv" + hero.level + "，" + (hero.status || ["健康"]).join("；") + "。",
    npc_cards: branch.npc_cards,
    world_status: "第 " + day + " 日，" + branch.location + "，" + time + "。已检索 " + memoryDocs.length + " 条相关记忆。",
    options: branch.options,
    log: [
      "玩家行动：" + action,
      branch.log,
      "本地演示模式只裁定可观察后果，不替玩家决定立场、台词或下一步。"
    ],
    state_patch: {
      world: {
        day,
        location: branch.location,
        time,
        active_events: branch.active_events
      }
    },
    memory_entries: [
      {
        type: "plot",
        tags: ["mock", "player-action", intent],
        text: "第 " + turn + " 轮，玩家选择“" + action + "”。结果：" + branch.log
      },
      ...branch.memory_entries
    ]
  };
}

function detectMockIntent(action) {
  const text = String(action || "");
  if (/公会|委托|登记|任务|悬赏/.test(text)) return "guild";
  if (/驿站|老板|旅店|追问|打听|询问/.test(text)) return "inn";
  if (/观察|距离|行人|记录|盯梢|暗中/.test(text)) return "observe";
  if (/林|道路|踪迹|痕迹|离开人群|脚印|魔兽/.test(text)) return "trail";
  if (/购买|装备|补给|市场|商会/.test(text)) return "supply";
  return "cautious";
}

function advanceMockTime(current, turn) {
  const order = ["清晨", "上午", "正午", "午后", "傍晚", "日暮", "入夜前", "夜色初临", "深夜前"];
  const known = order.indexOf(current || "傍晚");
  if (known >= 0) return order[Math.min(order.length - 1, known + 1)];
  return order[Math.min(order.length - 1, 4 + Math.floor(turn / 2))];
}

function buildMockBranch(intent, context) {
  const branches = {
    guild: mockGuildBranch,
    inn: mockInnBranch,
    observe: mockObserveBranch,
    trail: mockTrailBranch,
    supply: mockSupplyBranch,
    cautious: mockCautiousBranch
  };
  return (branches[intent] || mockCautiousBranch)(context);
}

function baseNpcCards() {
  return [
    {
      id: "mira-guild-clerk",
      name: "米拉",
      appearance: "戴铜框眼镜的公会记录员，袖口沾着墨迹，腰间挂着一串任务牌钥匙。",
      personality: "谨慎、重视手续，不喜欢空口承诺。",
      goal: "在边境混乱扩大前筛出可靠的新手。",
      weakness: "对伪造文书和贵族施压格外敏感。",
      secret: "她私下在追查一批被调包的低阶委托。",
      stance: "愿意观察玩家，但不会立刻信任。",
      affinity: 0,
      trust: 1,
      relationship: "初识",
      faction: "冒险者公会",
      mental_state: "警惕但保持职业礼貌"
    },
    {
      id: "hock-station-owner",
      name: "霍克",
      appearance: "肩背宽厚的驿站老板，右手旧伤让他倒酒时动作略慢。",
      personality: "现实、护短，先看利益再谈善意。",
      goal: "保住驿站生意，弄清失踪驮兽的去向。",
      weakness: "害怕守备队把责任推给驿站。",
      secret: "昨夜他听见林道方向传来像金属拖行的声音。",
      stance: "对陌生冒险者保持试探。",
      affinity: 0,
      trust: 0,
      relationship: "陌生人",
      faction: "边境驿站",
      mental_state: "焦躁，正在权衡是否透露更多"
    }
  ];
}

function mockGuildBranch({ action, memoryDocs, hero, time }) {
  return {
    location: "冒险者公会大厅",
    active_events: ["边境旧林道出现异常魔兽痕迹", "低阶委托板被临时封走三张任务牌"],
    scene: [
      "你选择了：" + action,
      "公会大厅比外面更亮，油灯挂在梁柱下，照出公告板上层层叠叠的羊皮纸。柜台后的记录员米拉抬起眼，先看你的手、靴子和随身物，再看你的脸。",
      "她没有替你登记任何身份，也没有替你选择委托，只把一块空白木牌推到柜台边缘。低阶委托板右下角有三处明显的空缺，像是刚被人匆忙摘走。旁边两名搬运工压低声音谈到“旧林道”“失踪驮兽”和“守备队不让靠近”。",
      "你现在获得了一个明确入口：公会愿意处理登记，但真正有价值的情报藏在被摘走的委托和大厅里互相回避的目光中。"
    ].join("\n\n"),
    reactions: [
      "米拉判断你还没有公会记录，因此不会主动把危险委托交给你。",
      "一名靠墙的老冒险者注意到你在看空缺任务牌，像是在评估你会不会贸然追问。",
      "大厅里的低声议论没有停止，说明旧林道事件并非孤立传闻。"
    ],
    npc_cards: baseNpcCards().slice(0, 1),
    options: [
      { id: "A", title: "申请新手登记", description: "按公会手续登记身份，但不承诺接取任何委托。" },
      { id: "B", title: "询问空缺任务牌", description: "向米拉打听被摘走的三张低阶委托。" },
      { id: "C", title: "旁听冒险者谈话", description: "保持距离，寻找旧林道事件的更多细节。" },
      { id: "D", title: "返回驿站核对传闻", description: "把公会听到的信息与驿站人员的说法对照。" }
    ],
    log: hero.name + " 抵达公会大厅，发现低阶委托板存在异常空缺。",
    memory_entries: [
      { type: "npc", tags: ["米拉", "公会"], text: "公会记录员米拉谨慎观察玩家，低阶委托板有三张任务牌被临时摘走。" },
      { type: "world", tags: ["旧林道", "委托"], text: "公会大厅流传旧林道和失踪驮兽相关消息；当前时间推进到" + time + "，检索到" + memoryDocs.length + "条上下文。" }
    ]
  };
}

function mockInnBranch({ action, hero, time }) {
  return {
    location: "边境驿站",
    active_events: ["驿站失踪两头驮兽", "守备队要求商队天黑后不得离站"],
    scene: [
      "你选择了：" + action,
      "霍克擦杯子的动作停了一下。驿站大厅里有湿木头和热汤的味道，靠窗的商队护卫把声音压得很低，像是怕话题被门外的守备兵听见。",
      "霍克没有立刻相信你。他把一枚裂开的马掌钉放到桌面上，钉身边缘发黑，像被某种酸液咬过。这个动作不是邀请你替他做决定，只是在试探你是否看得出问题。",
      "“昨夜不是狼。”他说到这里便停住，视线扫过门口的守备兵。更多话需要代价、信任，或一个能让他相信你不会乱传的理由。"
    ].join("\n\n"),
    reactions: [
      "霍克想知道你是求机会的新手，还是会把麻烦带进驿站的人。",
      "门口的守备兵听见“昨夜”两个字后抬了一下头。",
      "商队护卫互相交换眼神，他们显然也丢了东西。"
    ],
    npc_cards: baseNpcCards().slice(1),
    options: [
      { id: "A", title: "查看马掌钉", description: "只观察物证，不急着追问霍克的秘密。" },
      { id: "B", title: "询问失踪驮兽", description: "围绕昨夜事件追问，但不承诺帮忙。" },
      { id: "C", title: "留意守备兵反应", description: "判断守备队是否在隐瞒部分信息。" },
      { id: "D", title: "前往公会核对", description: "把驿站线索与公会委托进行交叉验证。" }
    ],
    log: hero.name + " 从霍克处看到被腐蚀的马掌钉，旧林道事件可能不是普通野兽造成。",
    memory_entries: [
      { type: "plot", tags: ["驿站", "物证"], text: "霍克展示被腐蚀的马掌钉，暗示昨夜袭击者并非普通狼群。时间：" + time + "。" }
    ]
  };
}

function mockObserveBranch({ action, hero }) {
  return {
    location: "边境驿站外",
    active_events: ["陌生书记员记录商队编号", "守备队封锁旧林道入口"],
    scene: [
      "你选择了：" + action,
      "你没有急着靠近任何人。车轮碾过泥水，商队伙计搬下木箱，守备兵在路口换岗。多数人都在忙自己的事，世界没有因为你沉默观察而停摆。",
      "几处细节逐渐浮出来：一名灰袍书记员正在记录商队编号，却故意避开公会方向；守备兵的靴底沾着暗绿色泥浆，而驿站附近没有这种泥；两个小贩谈到昨夜有“铃声”从旧林道传来。",
      "这些信息还不能组成结论，但足够让你知道，边境的不安不是单纯魔兽出没。有人在记录，有人在封锁，也有人在害怕说错话。"
    ].join("\n\n"),
    reactions: [
      "灰袍书记员察觉到有人在观察附近动线，暂时收起了记录册。",
      "守备兵不愿让平民靠近旧林道，他们的紧张不像例行巡逻。",
      "小贩们只敢交换碎片传闻，说明他们担心被追责。"
    ],
    npc_cards: [],
    options: [
      { id: "A", title: "跟踪灰袍书记员", description: "保持距离，弄清他记录商队编号的目的。" },
      { id: "B", title: "检查守备兵靴印", description: "确认暗绿色泥浆是否来自旧林道。" },
      { id: "C", title: "向小贩打听铃声", description: "用低风险方式收集昨夜传闻。" },
      { id: "D", title: "转往公会", description: "寻找能公开验证这些线索的渠道。" }
    ],
    log: hero.name + " 通过观察发现书记员、守备兵和旧林道之间存在异常联系。",
    memory_entries: [
      { type: "world", tags: ["观察", "守备队", "旧林道"], text: "玩家观察到灰袍书记员记录商队编号，守备兵靴底带有暗绿色泥浆，小贩提到旧林道铃声。" }
    ]
  };
}

function mockTrailBranch({ action, hero, time }) {
  return {
    location: "旧林道边缘",
    active_events: ["旧林道边缘发现非自然拖痕", "暗绿色泥浆与守备兵靴印吻合"],
    scene: [
      "你选择了：" + action,
      "旧林道边缘比驿站冷。草叶被压弯，泥地里有断续的拖痕，像重物被硬生生拉进林中。你没有深入到无法回头的位置，只在边缘确认能够看见的痕迹。",
      "泥里有兽蹄印，也有人类靴印。兽蹄印凌乱，靴印却成排出现，说明昨夜之后有人来过这里，而且不止一次。更奇怪的是，拖痕尽头挂着一小片红铜色鳞屑，摸上去冰凉，边缘带着淡淡酸味。",
      "林中深处传来很轻的铃响，随即消失。它不像风，也不像牲畜。是否继续靠近，仍由你决定。"
    ].join("\n\n"),
    reactions: [
      "林道深处的未知存在没有现身，但它似乎对边缘动静有反应。",
      "如果附近有守备队暗哨，他们现在可能已经注意到有人接近封锁线。",
      "红铜色鳞屑与普通魔兽不完全相符，值得保存或带去鉴定。"
    ],
    npc_cards: [],
    options: [
      { id: "A", title: "拾取鳞屑样本", description: "保存物证，暂不深入林道。" },
      { id: "B", title: "沿靴印返回", description: "反向追踪昨夜来过这里的人。" },
      { id: "C", title: "靠近铃声方向", description: "冒更高风险，尝试确认林中异常源头。" },
      { id: "D", title: "撤回公会报告", description: "把已确认痕迹交给公会换取正式委托机会。" }
    ],
    log: hero.name + " 在旧林道边缘发现拖痕、成排靴印和红铜色鳞屑。",
    memory_entries: [
      { type: "item", tags: ["鳞屑", "旧林道"], text: "旧林道边缘存在红铜色鳞屑，冰凉且带酸味；时间推进到" + time + "。" }
    ]
  };
}

function mockSupplyBranch({ action, hero }) {
  return {
    location: "驿站集市",
    active_events: ["补给价格上涨", "商会限制夜间出货"],
    scene: [
      "你选择了：" + action,
      "驿站旁的小集市还没收摊，麻绳、火油、干粮和粗制短刃摆在木板上。摊主们的报价比平时高，尤其是火把和止血布，涨价幅度不像普通天气导致。",
      "一个商会伙计正在把带商会纹章的箱子搬回仓库。他看见你停留，立刻把箱盖按紧。你能确认的只有一点：有人在为夜间封路做准备，而且消息比普通旅人知道得更早。",
      "你可以补给，也可以追查价格异常背后的消息。购买什么、花多少钱、是否透露目的，都仍由你决定。"
    ].join("\n\n"),
    reactions: [
      "摊主希望尽快卖出高价补给，但不想谈论涨价原因。",
      "商会伙计担心箱内物品被陌生人看见。",
      "几名新手冒险者正在犹豫是否合买一盏防风灯。"
    ],
    npc_cards: [],
    options: [
      { id: "A", title: "购买基础补给", description: "准备火把、干粮、绷带等低价物品。" },
      { id: "B", title: "询问涨价原因", description: "向摊主打听夜间封路和物资短缺。" },
      { id: "C", title: "观察商会箱子", description: "不靠近，只确认箱子纹章与搬运路线。" },
      { id: "D", title: "回到公会", description: "确认是否有补给相关的低阶委托。" }
    ],
    log: hero.name + " 发现驿站集市补给价格异常上涨，商会似乎提前得到消息。",
    memory_entries: [
      { type: "faction", tags: ["商会", "补给"], text: "驿站集市火把、止血布等补给上涨，商会伙计提前收回带纹章箱子。" }
    ]
  };
}

function mockCautiousBranch({ action, hero }) {
  return {
    location: "边境驿站外",
    active_events: ["旧林道传闻继续扩散", "公会和守备队互相观望"],
    scene: [
      "你选择了：" + action,
      "你的行动被世界承认，但它没有替你决定意图。边境驿站外的人流继续移动，商队赶在天黑前清点货物，守备兵在旧林道入口换上第二班岗。",
      "这一次行动带来的结果偏向保守：你没有立刻卷入冲突，也没有获得明确承诺，但你保留了选择余地。公会、驿站、旧林道和商会补给线都露出了可以继续追查的入口。",
      "如果你想让局势更快推进，可以选择一个明确对象：问谁、看哪里、跟踪什么，或提交自定义行动。"
    ].join("\n\n"),
    reactions: [
      "附近人物只是注意到你改变了位置，尚未形成明确判断。",
      "守备队继续封锁旧林道，说明他们并不希望平民自由接近。",
      "公会方向传来短促钟声，似乎有新的临时通知。"
    ],
    npc_cards: [],
    options: [
      { id: "A", title: "前往公会", description: "查看临时通知和新手登记。" },
      { id: "B", title: "询问驿站老板", description: "打听昨夜失踪驮兽和旧林道传闻。" },
      { id: "C", title: "保持距离观察", description: "继续记录人物动线和异常细节。" },
      { id: "D", title: "检查旧林道边缘", description: "在不深入的前提下查看痕迹。" }
    ],
    log: hero.name + " 采取谨慎行动，保持了多条调查路线。",
    memory_entries: [
      { type: "note", tags: ["谨慎行动"], text: "玩家采取未明确指向的谨慎行动，当前可继续从公会、驿站、观察、旧林道四条路线推进。" }
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

function retrieveContextDocuments(action, state, sessionSummary) {
  const index = ensureRagIndex(state, sessionSummary);
  const query = buildRagQuery(action, state);
  const documents = searchRagIndex(index, query, 20);
  const pinned = buildPinnedRagDocuments(state, sessionSummary);
  const merged = dedupeDocuments([...pinned, ...documents]);
  return merged.slice(0, 20);
}

function buildRagQuery(action, state) {
  return [
    action,
    state.hero?.name,
    state.hero?.race?.name,
    state.world?.location,
    ...(state.world?.active_events || []),
    ...(state.npcs || []).map((npc) => npc.name),
    ...(state.factions || []).map((faction) => faction.name)
  ].filter(Boolean).join(" ");
}

function getRagIndexStatus(state, sessionSummary) {
  const corpus = buildRagSourceDocuments(state, sessionSummary);
  const signature = makeRagSourceSignature(corpus);
  const index = readRagIndex();
  return {
    exists: Boolean(index),
    fresh: Boolean(index && index.sourceSignature === signature),
    documentCount: index?.documents?.length || 0,
    expectedDocumentCount: corpus.length,
    dimensions: index?.dimensions || RAG_VECTOR_DIMENSIONS,
    sourceSignature: signature,
    indexedSignature: index?.sourceSignature || null,
    updatedAt: index?.updatedAt || null
  };
}

function ensureRagIndex(state, sessionSummary) {
  const corpus = buildRagSourceDocuments(state, sessionSummary);
  const signature = makeRagSourceSignature(corpus);
  const existing = readRagIndex();
  if (existing && existing.sourceSignature === signature && Array.isArray(existing.documents)) return existing;
  return buildRagIndexFromCorpus(corpus, signature);
}

function buildRagIndex(state, sessionSummary) {
  const corpus = buildRagSourceDocuments(state, sessionSummary);
  return buildRagIndexFromCorpus(corpus, makeRagSourceSignature(corpus));
}

function buildRagIndexFromCorpus(corpus, sourceSignature) {
  const index = {
    version: 1,
    algorithm: "local-hashed-tf-cosine",
    dimensions: RAG_VECTOR_DIMENSIONS,
    sourceSignature,
    updatedAt: new Date().toISOString(),
    documents: corpus.map((doc) => {
      const text = `${doc.metadata.title || ""} ${(doc.metadata.tags || []).join(" ")} ${doc.pageContent}`;
      return {
        id: doc.metadata.id,
        pageContent: doc.pageContent,
        metadata: doc.metadata,
        vector: makeSparseVector(text),
        tokens: [...tokenize(text)],
        contentHash: hashText(text)
      };
    })
  };
  writeJson(RAG_INDEX_FILE, index);
  return index;
}

function readRagIndex() {
  if (!fs.existsSync(RAG_INDEX_FILE)) return null;
  try {
    return readJson(RAG_INDEX_FILE);
  } catch {
    return null;
  }
}

function summarizeRagIndex(index) {
  return {
    version: index.version,
    algorithm: index.algorithm,
    dimensions: index.dimensions,
    documentCount: index.documents.length,
    sourceSignature: index.sourceSignature,
    updatedAt: index.updatedAt
  };
}

function buildRagSourceDocuments(state, sessionSummary) {
  const loreDocuments = listLoreDocuments()
    .flatMap((item) => chunkLoreDocument(item))
    .map((chunk) => new Document({
      pageContent: [
        `# ${chunk.title}`,
        chunk.heading ? `## ${chunk.heading}` : "",
        chunk.content
      ].filter(Boolean).join("\n\n"),
      metadata: {
        id: `lore:${chunk.path}#${chunk.index}`,
        type: "lore",
        title: chunk.title,
        tags: chunk.tags || [],
        turn: null,
        createdAt: chunk.updatedAt,
        sourceUpdatedAt: chunk.updatedAt,
        importance: 2,
        sourcePath: chunk.path,
        heading: chunk.heading
      }
    }));

  const memoryDocuments = readJson(MEMORY_FILE).map((memory) => new Document({
    pageContent: memory.text || "",
    metadata: {
      id: `memory:${memory.id}`,
      type: memory.type || "note",
      title: memory.type || "memory",
      tags: memory.tags || [],
      turn: memory.turn,
      createdAt: memory.createdAt,
      sourceUpdatedAt: memory.createdAt,
      importance: memory.importance || 1
    }
  }));

  return [
    ...buildPinnedRagDocuments(state, sessionSummary),
    ...memoryDocuments,
    ...loreDocuments
  ].filter((doc) => String(doc.pageContent || "").trim());
}

function buildPinnedRagDocuments(state, sessionSummary) {
  const summaryText = sessionSummary?.summary || "暂无压缩会话记忆。";
  return [
    new Document({
      pageContent: JSON.stringify({
        hero: state.hero,
        world: state.world,
        npcs: state.npcs,
        factions: state.factions,
        abilities: state.abilities,
        inventory: state.inventory
      }, null, 2),
      metadata: {
        id: "structured-state",
        type: "structured_state",
        title: "结构化世界状态",
        tags: ["state", "hero", "world"],
        turn: state.turn || 0,
        createdAt: new Date().toISOString(),
        sourceUpdatedAt: `turn-${state.turn || 0}`,
        importance: 4
      }
    }),
    new Document({
      pageContent: summaryText,
      metadata: {
        id: "session-summary",
        type: "session_summary",
        title: "压缩会话记忆",
        tags: ["session", "summary"],
        turn: state.turn || 0,
        createdAt: sessionSummary?.updatedAt || null,
        sourceUpdatedAt: sessionSummary?.updatedAt || "empty",
        importance: 3
      }
    })
  ];
}

function makeRagSourceSignature(documents) {
  return hashText(JSON.stringify(documents.map((doc) => ({
    id: doc.metadata.id,
    sourceUpdatedAt: doc.metadata.sourceUpdatedAt,
    turn: doc.metadata.turn,
    hash: hashText(doc.pageContent)
  }))));
}

function searchRagIndex(index, query, limit = 20) {
  const queryVector = makeSparseVector(query);
  const queryTokens = tokenize(query);
  return (index.documents || [])
    .map((entry) => {
      const tokens = new Set(entry.tokens || []);
      const overlap = [...queryTokens].filter((token) => tokens.has(token)).length;
      const titleTokens = tokenize(`${entry.metadata?.title || ""} ${entry.metadata?.heading || ""}`);
      const titleBoost = [...titleTokens].filter((token) => queryTokens.has(token)).length * 0.6;
      const importanceBoost = Number(entry.metadata?.importance || 1) * 0.2;
      const recencyBoost = Math.min(0.5, Math.max(0, Number(entry.metadata?.turn || 0)) / 100);
      const vectorScore = cosineSimilarity(queryVector, entry.vector || []);
      return {
        entry,
        score: vectorScore * 8 + overlap + titleBoost + importanceBoost + recencyBoost
      };
    })
    .filter(({ score, entry }) => score > 0.3 || ["structured_state", "session_summary"].includes(entry.metadata?.type))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry, score }) => new Document({
      pageContent: entry.pageContent,
      metadata: {
        ...entry.metadata,
        score,
        ragAlgorithm: index.algorithm
      }
    }));
}

function dedupeDocuments(documents) {
  const seen = new Set();
  const result = [];
  for (const doc of documents) {
    const id = doc.metadata?.id || hashText(doc.pageContent || "");
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(doc);
  }
  return result;
}

function makeSparseVector(text) {
  const vector = Array(RAG_VECTOR_DIMENSIONS).fill(0);
  for (const term of tokenizeTerms(text)) {
    const index = parseInt(hashText(term).slice(0, 8), 16) % RAG_VECTOR_DIMENSIONS;
    vector[index] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude ? vector.map((value) => Number((value / magnitude).toFixed(6))) : vector;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += Number(left[index] || 0) * Number(right[index] || 0);
  return score;
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function retrieveLoreDocuments(action, state) {
  const query = [
    action,
    state.hero?.name,
    state.hero?.race?.name,
    state.world?.location,
    ...(state.world?.active_events || []),
    ...(state.npcs || []).map((npc) => npc.name),
    ...(state.factions || []).map((faction) => faction.name)
  ].filter(Boolean).join(" ");
  const queryTokens = tokenize(query);

  const scoredChunks = listLoreDocuments()
    .flatMap((item) => chunkLoreDocument(item))
    .map((chunk) => {
      const text = `${chunk.title} ${chunk.heading} ${(chunk.tags || []).join(" ")} ${chunk.content}`;
      const tokens = tokenize(text);
      const overlap = [...tokens].filter((token) => queryTokens.has(token)).length;
      const titleTokens = tokenize(`${chunk.title} ${chunk.heading}`);
      const titleBoost = [...titleTokens].filter((token) => queryTokens.has(token)).length * 2;
      return { chunk, score: overlap + titleBoost };
    })
    .filter(({ score }) => score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const fallbackChunks = scoredChunks.length ? scoredChunks : listLoreDocuments()
    .filter((item) => item.path.includes("000-world-core"))
    .flatMap((item) => chunkLoreDocument(item).slice(0, 3))
    .map((chunk) => ({ chunk, score: 0.1 }));

  return fallbackChunks.map(({ chunk, score }) => new Document({
    pageContent: [
      `# ${chunk.title}`,
      chunk.heading ? `## ${chunk.heading}` : "",
      chunk.content
    ].filter(Boolean).join("\n\n"),
    metadata: {
      id: `${chunk.path}#${chunk.index}`,
      type: "lore",
      tags: chunk.tags || [],
      turn: null,
      createdAt: chunk.updatedAt,
      importance: 2,
      score,
      sourcePath: chunk.path,
      heading: chunk.heading
    }
  }));
}

function chunkLoreDocument(item) {
  const sections = splitMarkdownSections(item.content || "");
  const chunks = [];
  let index = 0;

  for (const section of sections) {
    const parts = splitLongText(section.content, 1800);
    for (const part of parts) {
      const content = part.trim();
      if (!content) continue;
      chunks.push({
        ...item,
        index: index++,
        heading: section.heading || item.title,
        content
      });
    }
  }

  if (!chunks.length && item.content) {
    for (const part of splitLongText(item.content, 1800)) {
      chunks.push({
        ...item,
        index: index++,
        heading: item.title,
        content: part.trim()
      });
    }
  }

  return chunks;
}

function splitMarkdownSections(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const sections = [];
  let heading = "";
  let buffer = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match && buffer.length) {
      sections.push({ heading, content: buffer.join("\n").trim() });
      heading = match[2].trim();
      buffer = [];
      continue;
    }
    if (match && !buffer.length) {
      heading = match[2].trim();
      continue;
    }
    buffer.push(line);
  }

  if (buffer.length) sections.push({ heading, content: buffer.join("\n").trim() });
  return sections.filter((section) => section.content);
}

function splitLongText(text, maxLength) {
  const clean = String(text || "").trim();
  if (clean.length <= maxLength) return clean ? [clean] : [];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxLength) {
      current = paragraph;
    } else {
      for (let index = 0; index < paragraph.length; index += maxLength) {
        chunks.push(paragraph.slice(index, index + maxLength));
      }
      current = "";
    }
  }

  if (current) chunks.push(current);
  return chunks;
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

  let summary;
  try {
    summary = provider.mode === "mock"
      ? makeLocalSessionSummary(currentSummary.summary, pendingMessages)
      : await invokeSummaryChain(provider, currentSummary.summary, pendingMessages);
  } catch (error) {
    console.warn("Session summary compression failed, falling back to local summary:", error.message || error);
    summary = makeLocalSessionSummary(currentSummary.summary, pendingMessages);
  }

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

async function analyzeGrowth(payload) {
  const provider = payload.provider || {};
  const sessionId = sanitizeSessionId(payload.sessionId || DEFAULT_SESSION_ID);
  const context = buildGrowthContext(sessionId);
  const rawProposals = provider.mode === "mock"
    ? makeLocalGrowthProposals(context)
    : await invokeGrowthAnalyzeChain(provider, context);

  const proposals = (Array.isArray(rawProposals) ? rawProposals : rawProposals.proposals || [])
    .slice(0, 8)
    .map((proposal) => saveGrowthProposal(proposal));

  return { ok: true, proposals, growthDue: false };
}

function buildGrowthContext(sessionId) {
  return {
    state: readJson(STATE_FILE),
    rules: readJson(RULES_FILE),
    prompt: fs.existsSync(PROMPT_FILE) ? fs.readFileSync(PROMPT_FILE, "utf8") : "",
    lore: listLoreDocuments().map(({ title, path: lorePath, tags, content }) => ({
      title,
      path: lorePath,
      tags,
      content
    })),
    sessionSummary: readSessionSummary(sessionId),
    agentContract: readAgentContract(),
    activeAgent: getAgentById("growth-auditor"),
    proposalPolicy: {
      mode: "candidate_only",
      apply: "generate_patch_text_only",
      allowedTypes: ["prompt_patch", "rules_patch", "lore_gap", "consistency_warning"],
      mustNot: ["不要生成新剧情回合", "不要替玩家做决定", "不要直接改正式文件"]
    }
  };
}

async function invokeGrowthAnalyzeChain(provider, context) {
  if (!provider.apiKey) throw new Error("运行自生长审计需要玩家自己的智能体 API Key，或切换到本地演示模式。");
  if (provider.mode === "custom-json") return invokeCustomJsonGrowth(provider, context);

  const model = new ChatOpenAI({
    apiKey: provider.apiKey,
    model: provider.model || "gpt-4.1-mini",
    temperature: 0.3,
    configuration: {
      baseURL: normalizeOpenAIBaseURL(provider.baseUrl || "https://api.openai.com/v1")
    }
  });

  const chain = RunnableSequence.from([
    RunnableLambda.from((input) => [
      new SystemMessage([
        "你是中文 LangChain RAG 长期冒险 GM 项目的自生长审计器。",
        "只分析提示词、规则和 lore 资料库，不生成剧情回合。",
        "输出候选建议，必须等待用户确认，不能要求系统直接改正式文件。",
        "必须返回单个 JSON 对象，不要 Markdown，不要代码块。"
      ].join("\n")),
      new HumanMessage(JSON.stringify({
        task: "生成自生长候选建议。",
        output_schema: {
          proposals: [
            {
              type: "prompt_patch|rules_patch|lore_gap|consistency_warning",
              title: "中文标题",
              rationale: "为什么需要这个建议",
              risk: "low|medium|high",
              target_files: ["目标文件路径"],
              patch: "可读补丁或建议文本；不得声称已经修改文件"
            }
          ]
        },
        context: input
      }, null, 2))
    ]),
    model,
    new StringOutputParser(),
    tolerantJsonParser()
  ]);

  return chain.invoke(context);
}

async function invokeCustomJsonGrowth(provider, context) {
  if (!provider.baseUrl) throw new Error("请填写自定义智能体 API 地址。");
  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify({
      system: "你是中文 LangChain RAG 长期冒险 GM 项目的自生长审计器。返回 JSON：{proposals:[...]}。",
      input: JSON.stringify(context, null, 2)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.message || `自生长审计失败：${response.status}`);
  return parseAgentContent(data.output || data.answer || data.text || data.message || data.content || data);
}

function makeLocalGrowthProposals(context) {
  const proposals = [];
  if (!context.lore.length) {
    proposals.push({
      type: "lore_gap",
      title: "补充项目资料库初始世界观",
      rationale: "当前 lore 资料库为空，GM 只能依赖系统提示词和规则文件，长期一致性不足。",
      risk: "low",
      target_files: ["lore/000-world-core.md"],
      patch: "建议把已确认的异世界 GM 设定、角色创建规则、成长系统、NPC 关系、势力、战斗和长期记忆原则写入 lore/000-world-core.md。"
    });
  }
  if (!String(context.prompt).includes("资料库")) {
    proposals.push({
      type: "prompt_patch",
      title: "在 GM 提示词中明确优先遵守资料库",
      rationale: "当前提示词没有显式说明 lore 资料库的优先级，模型可能忽略长期背景文档。",
      risk: "medium",
      target_files: ["prompts/gm-system.md"],
      patch: "建议加入：当资料库、结构化状态和玩家行动存在冲突时，优先级为玩家当前行动 > 结构化状态 > 已确认资料库 > 压缩会话摘要 > 临场创作。"
    });
  }
  proposals.push({
    type: "consistency_warning",
    title: "保持自生长候选人工确认",
    rationale: "自生长系统如果直接改写规则或世界观，可能污染长期设定。",
    risk: "low",
    target_files: ["data/growth/proposals/"],
    patch: "继续保持 pending/accepted/rejected 流程；accepted 只生成 patch 文本，不直接改正式文件。"
  });
  return { proposals };
}

function isGrowthAuditDue(state, sessionSummary) {
  const turn = Number(state?.turn || 0);
  const covered = Number(sessionSummary?.coveredMessageCount || 0);
  return turn > 0 && (turn % 5 === 0 || covered >= 10);
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
  return new Set(tokenizeTerms(text));
}

function tokenizeTerms(text) {
  const normalized = String(text || "").toLowerCase();
  const latin = normalized.match(/[a-z0-9_-]{2,}/g) || [];
  const cjkText = normalized.replace(/[^\u4e00-\u9fff]/g, "");
  const cjk = [];
  for (let index = 0; index < cjkText.length; index += 1) {
    cjk.push(cjkText.slice(index, index + 1));
    if (index + 1 < cjkText.length) cjk.push(cjkText.slice(index, index + 2));
  }
  return [...latin, ...cjk].filter(Boolean);
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
  if (!fs.existsSync(FRONTEND_DIST_DIR)) {
    return sendJson(res, {
      error: "前端尚未构建。请先运行 npm run build，或直接运行 npm start。"
    }, 503);
  }
  let filePath = path.normalize(path.join(FRONTEND_DIST_DIR, pathname));
  if (!filePath.startsWith(FRONTEND_DIST_DIR)) return sendJson(res, { error: "Forbidden" }, 403);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(FRONTEND_DIST_DIR, "index.html");
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(filePath).pipe(res);
}
