# 架构说明

本文档说明“长期冒险 RAG GM”的核心结构，方便二次开发。

## 总览

项目采用本地优先架构：

- 前端：原生 HTML/CSS/JavaScript，负责角色创建、剧情展示、选项按钮、自定义行动、资料库追加和自生长候选管理。
- 后端：Node.js 原生 HTTP 服务，负责静态文件、状态持久化、RAG 上下文组装、LangChain 调用和文件读写。
- LangChain：用于模型调用、消息历史、文档包装、Runnable 链和 JSON 输出解析。
- Agent 契约：`agents/novel-gm-agents.json` 显式定义各 Agent 的职责、输入、输出和禁止行为。
- 存储：使用本地 JSON 与 Markdown 文件，不依赖数据库。

## 数据层

项目资料库：

```text
lore/
```

用于保存可版本管理的世界背景、规则、势力、NPC 和历史资料。

运行时数据：

```text
data/state.json
data/memories.json
data/sessions/
data/growth/proposals/
```

这些文件默认被 `.gitignore` 排除，不会进入公开仓库。

## RAG 上下文

每次玩家提交行动时，后端会组装以下上下文：

- 当前结构化状态：主角、世界、NPC、势力、能力、物品。
- 压缩会话摘要：`data/sessions/default/summary.json`。
- 运行时事实记忆：`data/memories.json`。
- 项目资料库文档：`lore/**/*.md`。

检索结果会包装为 LangChain `Document`，再交给 GM 链。

## Agent 层

项目包含四类核心 Agent：

- GM 主持 Agent：运行玩家行动后的下一轮回合。
- 记忆整理 Agent：压缩原始会话为长期摘要。
- 资料库管理员 Agent：管理和检索 `lore/` 资料。
- 自生长审计 Agent：生成提示词、规则和资料库改进候选。

后端会在相关链路中注入对应 Agent 契约，让模型按明确职责工作。

## 会话记忆

项目实现了文件版 `FileChatMessageHistory`：

- 原始消息保存到 `data/sessions/default/messages.json`。
- 达到阈值后调用智能体压缩到 `summary.json`。
- 后续回合优先携带摘要，减少 token 使用。

## 自生长候选

自生长不会直接修改正式文件。

流程：

1. 用户手动运行审计，或达到阈值后网页提示可审计。
2. 后端分析提示词、规则、资料库和会话摘要。
3. 生成 pending proposal。
4. 用户接受或拒绝。
5. 接受后仅生成 patch 文本，等待人工应用。

候选文件位于：

```text
data/growth/proposals/
```

## 设计原则

- 不替玩家决定。
- 资料库可增长，但正式设定必须可追踪。
- 运行时存档和公开项目资料分离。
- API Key 由玩家自己提供，项目不内置任何密钥。
