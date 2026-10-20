## PR 做了什么

<!-- 一句话说明这个 PR 的目的 -->

Closes #

> ⚠️ 这个 `Closes #` 必须指向**你认领过的 Issue**。没认领的 PR 无法判断是不是重复动工，会被退回——流程见 [CONTRIBUTING 第二节](CONTRIBUTING.md)。

## 变更类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `docs` 文档
- [ ] `refactor` 重构
- [ ] `perf` 性能
- [ ] `test` 测试
- [ ] `spec` 契约变更 ⚠️ 需架构评审
- [ ] `ci` / `build` / `chore`

## 开工认领自查

- [ ] 开工前跑过 `node scripts/claim.mjs ls --deep`，确认没人在做同一件事
- [ ] 对应 Issue 已 `claim`（assignee 是我，或沟通后 `--force` 接手）
- [ ] 改动在 `.worktrees/<branch>/` 独立工作区进行，没直接动主工作区

## 变更范围

<!-- 勾选涉及的部分 -->
- [ ] `orbital-hub`
- [ ] `matrix-sdk`
- [ ] `instrument-ui`
- [ ] `twin-schema`
- [ ] `copilot-router` / `pat-worker`
- [ ] `wechat-pocket`
- [ ] 微站 id：`__`
- [ ] 文档 / 规范

## 验证方式

<!-- 必填：怎么证明改对了？截图、测试输出、手动步骤 -->

```
（粘贴验证输出）
```

## 自查清单

- [ ] 已 rebase 到最新 `main`
- [ ] 提交信息符合 Conventional Commits
- [ ] `pre-commit` 校验已通过（`pnpm check` 或提交时自动执行）
- [ ] 无 `node_modules` / `.env` / 构建产物
- [ ] 无真实用户数据或未发表实验数据
- [ ] 无硬编码 API Key
- [ ] 若涉及视觉变更：已附前后对比截图
- [ ] 若涉及契约变更：已在 Issue 中说明影响面与迁移策略

## 截图（视觉变更必填）

| Before | After |
| :--- | :--- |
|  |  |
