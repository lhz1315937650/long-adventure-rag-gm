# 长期冒险 RAG GM

这是一个中文的、本地运行的 LangChain RAG 长期冒险小说 GM 系统。

它不是让 AI 直接替玩家写完小说，而是让智能体扮演长期游戏主持人（GM）：提供世界反馈、运行 NPC 与势力、裁定战斗与后果，并始终避免替玩家说话、决定、行动或选择立场。

## 核心功能

- 本地网页游玩：角色创建、剧情正文、状态栏、选项按钮、自定义行动输入。
- LangChain 后端：使用 `RunnableSequence`、`Document`、文件会话历史和 JSON 输出解析。
- 多 Agent 架构：显式定义 GM 主持、记忆整理、资料库管理员和自生长审计 Agent。
- RAG 长期记忆：组合检索结构化状态、会话摘要、运行时事实记忆和项目资料库。
- 项目资料库：`lore/` 保存世界观、规则、NPC、势力、历史和后续背景。
- 自生长候选：审计提示词、规则和资料库，生成候选建议与补丁文本，不自动污染正式设定。
- 玩家自带 API Key：网页填写自己的智能体 API Key；默认不会写入服务器文件。

## 运行要求

- Node.js 20 或更高版本，推荐 Node.js 24。
- npm。
- 可选：一个 OpenAI 兼容接口或自定义 Agent HTTP 接口。

## 安装与启动

```powershell
npm install
npm start
```

打开：

```text
http://localhost:8787
```

如果只想试用界面流程，可以在网页中选择 `本地演示模式`，不需要填写 API Key。

## 智能体 API 模式

网页支持三种模式：

- `OpenAI 兼容接口`：填写兼容 `/v1/chat/completions` 的 API 地址、模型名和玩家自己的 API Key。
- `自定义 Agent JSON`：把上下文发送给你自己的 Agent HTTP 接口。
- `本地演示模式`：不调用外部模型，只用于测试网页流程和存档结构。

API Key 默认只保存在当前网页输入框中，并随请求发送给本地后端，不会写入服务器文件。

如果勾选“保存在此浏览器”，Key 会保存到浏览器 `localStorage`。公开使用或共享电脑时不建议勾选。

## 项目资料库

`lore/` 是可版本管理的世界资料库，用来保存长期背景：

- 世界观
- 种族与势力
- NPC 设定原则
- 战斗与成长规则
- 历史事件
- 后续新增故事背景

当前初始资料位于：

```text
lore/000-world-core.md
```

网页右侧的“资料库”面板可以继续追加新背景。新增资料会写入 `lore/`，适合后续提交到 Git。

## 长期记忆结构

运行时数据保存在 `data/`：

- `data/state.json`：当前主角、世界、NPC、势力、物品和最近一轮。
- `data/memories.json`：运行中产生的长期事实记忆。
- `data/sessions/default/messages.json`：完整原始会话消息。
- `data/sessions/default/summary.json`：压缩后的会话摘要。
- `data/growth/proposals/`：自生长候选和补丁建议。

这些运行时文件默认不会提交到 Git。

## 自生长机制

自生长第一版只做“候选建议”，不会直接修改正式设定。

它会分析：

- GM 系统提示词。
- 机器可读规则。
- `lore/` 资料库。
- 当前结构化状态。
- 压缩会话摘要。

然后生成候选：

- `prompt_patch`：提示词优化建议。
- `rules_patch`：规则补全建议。
- `lore_gap`：资料库缺口。
- `consistency_warning`：一致性风险提示。

候选状态包括：

- `pending`
- `accepted`
- `rejected`

接受候选后，系统只会在 `data/growth/proposals/` 生成可读补丁文件，不会自动改写 `prompts/`、`data/rules.json` 或 `lore/`。

## Agent 系统

Agent 契约位于：

```text
agents/novel-gm-agents.json
```

当前包含：

- GM 主持 Agent。
- 记忆整理 Agent。
- 资料库管理员 Agent。
- 自生长审计 Agent。

网页右侧会展示当前代理系统。后端在 GM 回合和自生长审计时会把对应 Agent 契约注入上下文。

## RAG 检索方式

当前版本使用轻量本地检索：

- 从玩家行动、主角、地点、NPC、势力中提取关键词。
- 检索 `data/memories.json`。
- 检索 `lore/**/*.md`。
- 注入压缩会话摘要。
- 注入当前结构化状态。

检索结果会包装为 LangChain `Document`，后续可以升级为 SQLite FTS、本地向量库或 PostgreSQL + pgvector。

## 开发脚本

```powershell
npm run check
```

检查：

- `server.js`
- `public/app.js`

## 开发文档

- [架构说明](docs/ARCHITECTURE.md)
- [API 说明](docs/API.md)
- [Agent 系统说明](docs/AGENTS.md)
- [贡献指南](CONTRIBUTING.md)
- [更新日志](CHANGELOG.md)

## 安全说明

- 不要把 `.env`、API Key、玩家存档或会话记忆提交到公开仓库。
- `.gitignore` 已默认排除运行时数据和密钥文件。
- 自定义 Agent 接口由用户自己提供，项目不会内置第三方 API Key。

## 开源协议

MIT License。
