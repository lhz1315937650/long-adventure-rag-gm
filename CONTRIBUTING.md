# 贡献指南

欢迎提交 issue、建议和 pull request。

## 开发环境

```powershell
npm install
npm run check
npm start
```

打开：

```text
http://localhost:8787
```

## 提交前检查

请至少运行：

```powershell
npm run check
```

不要提交：

- `.env`
- API Key
- `node_modules/`
- `data/state.json`
- `data/memories.json`
- `data/sessions/`
- `data/growth/`

## 资料库贡献

世界观、规则、NPC、势力和历史资料应写入：

```text
lore/
```

请保持中文描述清晰，并尽量避免和已有设定冲突。

## 自生长建议

自生长输出应先作为候选，不应直接改写正式设定。

推荐流程：

1. 生成 proposal。
2. 人工审查。
3. 接受后生成 patch。
4. 由维护者决定是否应用。

## 代码风格

当前项目尽量保持简单：

- 原生 Node.js HTTP 服务。
- 原生前端。
- 不引入不必要的构建工具。
- 优先保持本地可运行和易理解。
