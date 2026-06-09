import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const agentFile = path.join(root, "agents", "novel-gm-agents.json");

const requiredAgentFields = [
  "id",
  "name",
  "role",
  "responsibilities",
  "forbidden",
  "inputs",
  "outputSchema"
];

const contract = JSON.parse(fs.readFileSync(agentFile, "utf8"));
const errors = [];

if (!contract.systemName) errors.push("缺少 systemName。");
if (!Array.isArray(contract.globalInvariants) || contract.globalInvariants.length < 3) {
  errors.push("globalInvariants 至少需要 3 条。");
}
if (!Array.isArray(contract.agents) || contract.agents.length < 4) {
  errors.push("至少需要定义 4 个 Agent。");
}

const ids = new Set();
for (const agent of contract.agents || []) {
  for (const field of requiredAgentFields) {
    if (!(field in agent)) errors.push(`${agent.id || "未知 Agent"} 缺少字段 ${field}。`);
  }
  if (ids.has(agent.id)) errors.push(`重复 Agent id：${agent.id}`);
  ids.add(agent.id);
  if (!Array.isArray(agent.responsibilities) || !agent.responsibilities.length) {
    errors.push(`${agent.id} responsibilities 不能为空。`);
  }
  if (!Array.isArray(agent.forbidden) || !agent.forbidden.length) {
    errors.push(`${agent.id} forbidden 不能为空。`);
  }
  if (!agent.outputSchema || typeof agent.outputSchema !== "object") {
    errors.push(`${agent.id} outputSchema 必须是对象。`);
  }
}

for (const route of contract.routing || []) {
  if (!ids.has(route.agent)) errors.push(`routing 引用了不存在的 Agent：${route.agent}`);
}

if (errors.length) {
  console.error("Agent 契约检查失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Agent 契约检查通过：${contract.agents.length} 个 Agent。`);
