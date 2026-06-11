# API 说明

后端默认运行在：

```text
http://localhost:8787
```

开发模式下，React/Vite 前端运行在 `http://127.0.0.1:5173`，并把 `/api` 代理到后端。

所有接口默认使用 JSON。

接口的核心用途是支撑“玩家行动 -> LangChain RAG 上下文 -> AI 小说正文与 GM 裁定 -> 状态和记忆更新”这条主链路。React 前端只是调用这些接口的本地表现层。

## GET /api/bootstrap

获取前端启动所需状态。

返回：

- `state`：当前游戏状态。
- `rules`：角色创建和规则数据。
- `memoryCount`：运行时记忆条数。
- `loreCount`：资料库文档数量。
- `ragIndex`：本地 RAG 索引状态。
- `growthDue`：是否建议运行自生长审计。
- `sessionSummary`：压缩会话摘要。

## POST /api/create-character

创建角色。

请求字段：

- `name`
- `raceId`
- `stats`
- `mainTalentId`
- `subTalentId`

属性点必须刚好等于种族初始点数。

## POST /api/turn

提交玩家行动并运行下一轮 GM。

请求字段：

- `action`：玩家行动文本。
- `provider`：智能体配置。

`provider` 示例：

```json
{
  "mode": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "model": "your-model",
  "apiKey": "your-api-key"
}
```

本地演示模式：

```json
{
  "mode": "mock"
}
```

## GET /api/lore

列出 `lore/` 资料库文档。

## GET /api/rag/status

查看本地 RAG 索引状态。

返回：

- `exists`：索引文件是否存在。
- `fresh`：索引是否与当前资料库、记忆、摘要和结构化状态一致。
- `documentCount`：当前索引内的文档块数量。
- `expectedDocumentCount`：按当前语料应生成的文档块数量。
- `dimensions`：本地词向量维度。
- `sourceSignature`：当前语料签名。
- `indexedSignature`：索引文件签名。
- `updatedAt`：索引更新时间。

## POST /api/rag/rebuild

手动重建本地 RAG 索引。

索引会写入 `data/rag-index.json`。这是运行时文件，默认不提交到 Git。

## GET /api/agents

返回当前 Agent 系统契约。

包括：

- `globalInvariants`
- `agents`
- `routing`

## POST /api/lore

新增背景资料。

请求字段：

- `title`
- `tags`
- `content`

新增内容会保存为 Markdown 文件。

## POST /api/growth/analyze

运行自生长审计。

请求字段：

- `provider`

返回 pending proposals。自生长不会直接修改正式文件。

## GET /api/growth/proposals

列出自生长候选。

## POST /api/growth/proposals/:id/decision

接受或拒绝候选。

请求字段：

```json
{
  "decision": "accepted"
}
```

接受后只生成 patch 文本，不会自动改正式文件。

## GET /api/export

导出当前状态、规则、记忆、资料库和自生长候选。

## POST /api/reset

重置运行时存档、运行时记忆和会话历史。

不会删除 `lore/` 项目资料库。
