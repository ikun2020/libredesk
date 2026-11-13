# LibreDesk fork 定制与同步记录

记录日期：2026-11-13（Asia/Shanghai）。这是用户明确要求保留的项目维护记录，供后续 fork sync、升级和冲突处理使用。

## 仓库与功能基线

| 项目 | 记录 |
| --- | --- |
| 用户 fork | [ikun2020/libredesk](https://github.com/ikun2020/libredesk)，默认分支 `main` |
| 原项目 | [abhinavxd/libredesk](https://github.com/abhinavxd/libredesk)，默认分支 `main` |
| 首次定制前的上游基线 | `88ec89ab21a912ca402fbfd2fd4f984d95d88175` |
| 当前两项定制的功能基线 | `a08ec969301b2b2dfbbc971ef88847283a168471` |
| 此基线已发布镜像 | `ghcr.io/ikun2020/libredesk:sha-a08ec96`，应用版本 `v2.9.2+git.a08ec969` |
| 发布验证 | [Docker image 构建](https://github.com/ikun2020/libredesk/actions/runs/43418248215) |

以上是建档时的历史基线，不代表将来 `latest` 的版本。本次建档不执行上游同步，也不修改应用功能。

## 1. 会话更新按内容自动回复

提交：[6400152b](https://github.com/ikun2020/libredesk/commit/6400152b6b55aed620521fe1b660bbb450f2a713)，[PR #1](https://github.com/ikun2020/libredesk/pull/1)。

### 用户需要的行为

- 不依赖 AI。在“自动化 → 会话更新”中可设置内容条件，并发送固定回复。
- 示例配置：事件选“收到消息”，条件为目标收件箱且内容包含“优惠券”，动作发送“123456”。后续每一条匹配的客户消息都能触发；没有新增会话级只回复一次或冷却限制。
- 首条消息仍使用“新建会话”规则。若首条和后续都要回复，应分别配置两种规则，避免首条消息重复执行。
- “内容”条件仅扩展到会话更新自动化；普通会话筛选、时间触发器保持各自原有条件集合。

### 合并时必须保留

- `EvaluateMessageRules` 使用触发该事件的 `message.TextContent`。不能恢复为读取可能已被后续消息或“会话重新打开”活动覆盖的会话预览。
- 空文本也必须覆盖旧预览，图片消息不能借用旧消息中的关键词触发回复。
- 只替换排队评估的会话副本中的内容；不要改变数据库预览或其他 webhook/钩子使用的会话。保留重新打开时的 `previousValues`。
- 保留系统消息、自动发送消息的过滤，防止回复再次触发回复。人工发出消息的既有 outgoing 规则仍有效，但不能触发仅订阅 incoming 的关键词规则。
- 保留文本操作符、大小写选项，以及编辑、保存、重新加载规则的能力。

### 文件与测试

| 用途 | 路径（仓库相对） |
| --- | --- |
| 自动化内容条件 | `frontend/apps/main/src/composables/useConversationFilters.js` |
| 会话更新规则表单 | `frontend/apps/main/src/features/admin/automation/RuleBox.vue` |
| 触发消息快照评估 | `internal/automation/automation.go` |
| 消息事件接入 | `internal/conversation/message.go` |
| 使用说明 | `README.md` 的 Keyword auto-replies |
| 后端回归 | `internal/automation/message_rules_test.go` |
| 表单回归 | `frontend/cypress/e2e/ui/automationForm.cy.js` |
| 实际消息回归 | `frontend/cypress/e2e/integration/livechat/keywordAutomation.cy.js` |

## 2. iPhone DUO 显示与回复输入

初始修复：[9fbed06e](https://github.com/ikun2020/libredesk/commit/9fbed06e70efa9b83a3c055ba23468fe603d6e69)，[PR #2](https://github.com/ikun2020/libredesk/pull/2)。

最终交互：[a08ec969](https://github.com/ikun2020/libredesk/commit/a08ec969301b2b2dfbbc971ef88847283a168471)，[PR #3](https://github.com/ikun2020/libredesk/pull/3)。这两次提交共同构成触屏修复；只保留第一次会恢复用户不接受的自动全屏入口。

### 用户确认的最终行为

- 在会话底部默认显示真正的可编辑输入框，直接点击正文输入，尽量保留聊天记录可见。
- 不要求先点“回复”打开全屏，再点正文；全屏仅在用户手动选择时开启，返回后保留草稿。
- 键盘弹出、收起以及折叠屏展开/折起时，不能卸载和重建正在输入的编辑器，必须保留 DOM、焦点与草稿。
- 编辑区空白处也能点击聚焦；长草稿在输入区内滚动，发送按钮保持可用。

### 合并时必须保留

- `ReplyBox.vue` 的折叠状态取决于用户的 `isMinimized`，不能恢复为 `isCramped || isMinimized`，也不能因高度阈值自动进入全屏。
- 触屏默认展开，手动收起状态与桌面持久化收起偏好分离；保留桌面原有行为。
- coarse 主指针设备不因初始化、草稿加载、回复类型或会话变化而自动抢焦点。默认输入依靠用户点击已经挂载的真实编辑器。
- 保留 `ConversationEditor` 的 flex 铺满布局；别让底部空白区域落在不可编辑的包装元素上。
- `App.vue` 统一监听可见视口。触屏根布局随 `visualViewport.height` 变化，兼容键盘只改变 visual viewport、没有 window resize 的浏览器；无该 API 时回退 `innerHeight`。
- 保留缩放保护、监听器清理和 CSS 变量恢复，避免捏合缩放造成整体布局重排或残留高度。
- 回复框的顶部操作与发送栏不能被正文挤走；邮件字段、附件及长草稿需要可滚动空间，编辑器保留最小高度。
- `useIsComposerCramped` 在回复框中用于手动全屏尺寸及紧凑提示，不再决定是否挂载默认输入框。其历史注释提到触屏全屏，不应作为恢复自动全屏的依据。

### 文件与测试

| 用途 | 路径（仓库相对） |
| --- | --- |
| 触屏根布局 | `frontend/apps/main/src/App.vue` |
| 可见视口监听 | `frontend/apps/main/src/composables/useVisualViewportHeight.js` |
| 紧凑布局判断 | `frontend/apps/main/src/composables/useIsComposerCramped.js` |
| 默认内联、手动收起和全屏 | `frontend/apps/main/src/features/conversation/ReplyBox.vue` |
| 输入区布局与触屏焦点 | `frontend/apps/main/src/features/conversation/ReplyBoxContent.vue` |
| 可编辑区域铺满 | `frontend/apps/main/src/components/editor/ConversationEditor.vue` |
| 焦点回归 | `frontend/apps/main/src/features/conversation/ReplyBoxContent.test.js` |
| 可见视口回归 | `frontend/apps/main/src/composables/useVisualViewportHeight.test.js` |
| 触屏发送与布局回归 | `frontend/cypress/e2e/ui/touchReplyComposer.cy.js` |

触屏 Cypress 测试使用 CDP 真实触控模拟，同时影响 CSS 和 JavaScript 的媒体查询；不要退回只 stub `matchMedia` 的方式，否则无法验证触屏 CSS。浏览器模拟不能证明系统软键盘一定弹出，涉及输入布局的上游更新仍应在用户设备上复测 Safari/Chrome。

## 同步上游的方法

目标是保留上游改进和这两项行为，而不是永久冻结这些文件。GitHub 提示冲突时需要按语义合并；维护记录不能保证今后永远没有冲突。

1. 读取本记录，检查工作区和远程地址，保留未提交工作。先记录同步前的 fork HEAD 并建立备份引用。
2. 从最新 `origin/main` 创建 `codex/sync-upstream-日期` 分支，再合并原项目 `main`。记录本次上游 SHA。
3. 逐段解决冲突，检查以上行为与调用链，不能整文件盲选 ours/theirs。不要用重置到上游、丢弃 fork 提交或强制推送作为常规同步办法。
4. 即使没有文本冲突，也运行下方回归。若上游已提供等价功能，可适配或移除重复实现，并保留行为与测试，避免执行两遍。
5. 验证后按当前任务的发布要求合入 fork `main`；需要发布时等待 GHCR 构建和镜像验证成功。更新本记录的同步日志、路径及替代提交。

命令示意，`YYYYMMDD` 应替换为本次同步日期，重复同步时另加唯一后缀。在仓库目录执行；先确保工作区干净：

```sh
git status --short
git remote -v
# 仅在 upstream 不存在时添加；已有时先核对它是否指向原项目。
git remote add upstream https://github.com/abhinavxd/libredesk.git
git fetch origin
git fetch upstream
git switch -c codex/sync-upstream-YYYYMMDD origin/main
git branch codex/backup-before-sync-YYYYMMDD
git rev-parse HEAD upstream/main
git merge --no-ff upstream/main
```

记录建立时只有 `origin`，尚未添加或拉取 `upstream`。若需退出尚未完成的合并，可使用 `git merge --abort`；不要丢弃用户工作。上述命令仅准备合并，不会自动发布。[Git 合并冲突处理文档](https://git-scm.com/docs/git-merge)

## 同步后的回归清单

- [ ] 自动化表单仍能保存“会话更新 + 收到消息 + 内容包含优惠券 + 固定回复123456”。
- [ ] 首条消息、后续匹配消息、重新打开的会话行为正确；不匹配、空文本、自动发送消息不误触发或循环。
- [ ] 展开和折起的触屏都默认底部直接输入；输入区空白点击、草稿、发送正常。
- [ ] 键盘高度变化及仅 visual viewport 变化不更换编辑器节点；聊天记录、发送按钮仍可见。
- [ ] 手动全屏往返保留草稿；桌面焦点、收起偏好、邮件和附件正常。
- [ ] 保留并运行上述单元和 Cypress 回归；通过现有 `Go` 与五分片 `CI` 工作流后发布功能更新。
- [ ] 发布后核对镜像 revision/version 与本次功能提交相符，确认 `latest` 指向新镜像。

本地定向检查（依赖版本以 `go.mod`、`frontend/package.json` 和锁文件为准；Go 数据库集成测试需要 PostgreSQL 与 `LIBREDESK_TEST_DB_DSN`，Cypress 需要运行中的后端和测试服务，可参照现有工作流配置）：

```sh
go test ./internal/automation ./internal/conversation
cd frontend
pnpm test:run
pnpm exec cypress run --e2e --spec "cypress/e2e/ui/automationForm.cy.js,cypress/e2e/integration/livechat/keywordAutomation.cy.js,cypress/e2e/ui/touchReplyComposer.cy.js"
```

环境不足时以配置好依赖的 GitHub Actions 验证，不应省略必需检查。建档时的功能基线已通过 Go、71 个前端单元测试文件（1,118 项测试）、五分片 Cypress，以及 WebKit 触屏组件检查；这不替代以后每次同步后的验证。

## 相关发布配置也需保留

这两项功能依靠 fork 自己的镜像发布。同步 `.github/workflows` 时一并检查：

- [44791e8b](https://github.com/ikun2020/libredesk/commit/44791e8b23a0835ae3a3d8bdcc91a1e0a9bdca83)：`.github/workflows/docker.yml` 发布到 `ghcr.io/ikun2020/libredesk`；`latest`/`main` 跟随本 fork 默认分支。原上游发布工作流有仓库限制。
- [8e13ad54](https://github.com/ikun2020/libredesk/commit/8e13ad545da61e27f580eeace416972530e6ad69)：从上游标签解析应用版本并附加 Git 提交信息，避免 fork 构建退回 `v0.0.0` 后产生错误更新提示；保留镜像版本冒烟检查。
- 部署应使用 fork 的 GHCR 镜像；上游 `docker-compose.yml` 的默认 Docker Hub 镜像不包含这些定制。

## 同步日志

| 日期 | 结果 |
| --- | --- |
| 2026-11-13 | 建立两项定制维护记录；功能基线 `a08ec969`，本次未执行上游同步。 |
