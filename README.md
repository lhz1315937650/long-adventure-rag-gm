# 长期冒险 RAG GM

本项目是一个本地运行的长期冒险小说 GM 原型。

它的目标不是替玩家写完整小说，而是让智能体扮演 GM：

- 提供种族框架和数值规则。
- 运行世界事件、NPC 行动和势力变化。
- 根据玩家选择反馈结果。
- 绝不替玩家说话、决定、行动或选择立场。
- 通过本地 JSON 记忆库保存剧情、NPC、关系、物品、能力和世界状态。

## 启动

```powershell
npm start
```

然后打开：

```text
http://localhost:8787
```

## 智能体 API

网页支持三种模式：

- `OpenAI 兼容接口`：填写兼容 `/v1/chat/completions` 的 API 地址、模型名和玩家自己的 API Key。
- `自定义 Agent JSON`：把完整上下文发给自定义 Agent HTTP 接口。
- `本地演示模式`：不调用外部智能体，只用于测试网页流程。

API Key 默认只保存在当前网页输入框中，并随请求发送给本地后端，不会写入服务器文件。
如果勾选“保存在此浏览器”，Key 会保存到浏览器 localStorage。

## LangChain 技术栈

后端采用 LangChain JS：

- `@langchain/core`：`Document`、`BaseChatMessageHistory`、`RunnableSequence`、输出解析。
- `@langchain/openai`：OpenAI 兼容 Chat Model 调用。
- 项目内实现 `FileChatMessageHistory`，用于把每个会话的原始消息保存到本地文件。

## 长期会话记忆

会话记忆保存在项目专用目录：

- `data/sessions/default/messages.json`：完整原始对话消息。
- `data/sessions/default/summary.json`：压缩后的长期会话摘要。

每一轮会保存：

- 玩家提交的行动。
- GM 返回的 JSON 回合结果。

当未压缩消息达到阈值后，系统会调用玩家配置的智能体 API 更新摘要。后续 GM 回合只携带：

- 当前结构化状态。
- 压缩会话摘要。
- 检索到的少量相关事实记忆。

这样可以避免长期游玩时 token 持续膨胀。

## 数据文件

- `data/state.json`：当前角色、世界、NPC、势力、物品和最近一轮。
- `data/memories.json`：长期记忆条目。
- `data/rules.json`：种族、属性、等级、天赋规则。
- `prompts/gm-system.md`：GM 系统提示词。

## 当前 RAG 方式

第一版使用轻量本地检索，并把结果包装成 LangChain `Document`：根据玩家行动、角色、地点、NPC 和势力做关键词重叠检索。

后续可以升级为：

- SQLite FTS。
- 本地 embedding 向量库。
- PostgreSQL + pgvector。
- 混合检索：结构化状态 + 向量记忆 + 最近剧情窗口。
