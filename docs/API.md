# API 说明

后端默认运行在：

```text
http://localhost:8787
```

所有接口默认使用 JSON。

## GET /api/bootstrap

获取前端启动所需状态。

返回：

- `state`：当前游戏状态。
- `rules`：角色创建和规则数据。
- `memoryCount`：运行时记忆条数。
- `loreCount`：资料库文档数量。
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
