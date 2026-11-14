# LibreDesk fork 定制与同步记录

记录日期：2026-11-13（Asia/Shanghai）。这是项目定制维护记录，供用户明确要求的 fork sync、同步上游或合并上游版本时使用。最初两项定制及后续新增功能的历史记录保留如下。

## 适用范围

仅在用户明确要求 fork sync、同步上游时，检查与上游的代码冲突，并读取、执行本文的定制保留清单及同步回归。日常功能修改、修复和镜像发布不自动进入同步流程，也不需要额外核对全部历史定制；仍按实际改动范围进行正常、必要的测试和 CI。本文不额外要求日常修改执行同步用的全量回归。

长期只保留本地及 fork 的 `main` 分支。同步确需临时分支时，确认合入后删除本地和 fork 上的临时分支；用记录的提交 SHA 和 Git 历史回溯，不再保留长期备份分支。下文出现的旧分支名是历史记录。

## 仓库与功能基线

| 项目 | 记录 |
| --- | --- |
| 用户 fork | [ikun2020/libredesk](https://github.com/ikun2020/libredesk)，默认分支 `main` |
| 原项目 | [abhinavxd/libredesk](https://github.com/abhinavxd/libredesk)，默认分支 `main` |
| 首次定制前的上游基线 | `88ec89ab21a912ca402fbfd2fd4f984d95d88175` |
| 当前两项定制的功能基线 | `a08ec969301b2b2dfbbc971ef88847283a168471` |
| 最近合入的上游 main | `2d0617d79932d45f2b1cc8c538d7efe8be73b448`（2026-11-14） |
| 本次同步前 fork 主分支 | `9abe298557f49d47b7845ef06879a1a3b1514d35` |
| 此基线已发布镜像 | `ghcr.io/ikun2020/libredesk:sha-a08ec96`，应用版本 `v2.9.2+git.a08ec969` |
| 发布验证 | [Docker image 构建](https://github.com/ikun2020/libredesk/actions/runs/43418248215) |

功能及镜像基线是建档时的历史记录，不代表将来 `latest` 的版本。建档时未执行上游同步；后续同步记录见上表和末尾日志。

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
- 键盘平移主界面时，`.app-viewport` 包装层用正常流 `padding-top` 跟随 `visualViewport.pageTop`，内部 `.app-shell` 使用可见高度。补偿空间必须计入父元素高度，不能改回仅在壳层上相对定位，否则 `body { overflow:hidden }` 会裁掉输入区；不能叠加 `scrollY + offsetTop` 重复补偿。键盘收起清零，弹窗输入不移动后台主界面，焦点与草稿不变。验证时保留真实外层高度并检查输入区/发送按钮的点击命中，不能人为增大 body 高度掩盖裁剪。
- `9d64fb83` 发布后，用户已在 iPhone DUO 真机确认“输入框已正常显示”。后续后台恢复诊断不能回退该正常流补偿。
- PWA 从后台恢复、页面恢复、窗口重新获焦及折叠/方向变化时，重新读取可见视口，并在下一帧与有限的延迟回调中复核尺寸。后台和零尺寸测量不能覆盖有效高度；不要只依赖 `resize`。
- 保留 `a44dcd07` 中独立触屏窗口低于 1 的缩放值、但视觉/布局/窗口宽度一致且无偏移时的高度更新例外；真实手势缩放仍不能引发重排。用户曾反馈该版本后台恢复正常，但在 `46f24bd1` 再次报告无输入时也会下移，不能将之前一次确认视为永久解决；后续修复需复测独立的后台切换路径。
- `46f24bd1` 的后台独立报告显示：无输入、无旋转操作时出现系统方向切换事件，返回后可见高度从 669 降为 587，而缩放为 1、根布局高度为 587、偏移为 0。该现象不能用键盘裁剪或过期 CSS 高度解释。布局诊断提供手动“重新计算显示区域（测试）”：只在同宽同方向、无缩放和输入焦点的独立触屏窗口中，短暂请求录制开始时的健康高度并恢复原 viewport 元数据，记录前后结果。它尚待真机确认，不能自动执行、刷新页面或据此声称后台问题已经修复。
- `9d64fb83` 的后台报告又出现缩放 0.912，但可见/窗口/文档宽度均为 867、偏移为 0，正常基线仍为 867×669。手动重算应兼容这一已知恢复异常；真实缩放造成的宽度不一致仍拒绝执行。诊断需记录拒绝原因，不能统一要求用户重新录制；该测试尚未证明能恢复系统提供的显示区域。
- 触屏独立 PWA 恢复时，仅在没有正在编辑且没有捏合缩放的情况下，将残留的根文档滚动位置归零。不能重置收件箱/聊天记录内部滚动，不能重建编辑器、清除草稿或抢焦点；普通浏览器标签页与桌面不执行此纠正。
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

## 3. 访客聊天首条消息发送附件

实现分支：`codex/widget-first-attachment`，基于同步提交 `d5567eff`。发布与验证结果见该功能 PR。

### 用户需要的行为

- 收件箱开启文件上传时，新会话输入框立即显示附件按钮，不必先发送文字。
- 保持原有“选择文件后立即上传发送”的交互，支持附件作为首条消息；取消选择不创建会话。
- 首次附件发送成功后，已输入但尚未发送的文字迁移到新会话草稿，继续等待用户发送。
- 上传期间禁用文字发送、快捷回复及重复选择；失败后恢复控件，可以重新选择同一个文件重试。

### 合并时必须保留

- 初始化接口继续兼容原有 JSON 文字请求，新增 multipart 请求使用 `payload` JSON 字段和 `files` 文件字段；无需先创建空白会话或发送占位文字。
- 首条附件和后续附件执行相同的上传开关、文件大小、扩展名和空文件校验。无效附件在创建访客或会话之前被拒绝，不放宽身份与会话权限。
- 保留预聊天表单、匿名/认证用户、主动邀请及禁止新建/重复会话的原有校验。
- 附件必须真正存储并关联到首条消息；新会话自动化仍只执行首条消息钩子，不能把首附件误当成会话更新事件。
- 上传过程中切换会话，完成或失败回调不能修改另一会话的消息与草稿。
- 上传过程中退出或切换身份，旧初始化响应不能恢复旧身份的会话、登录状态或草稿。
- PWA 右侧导航按钮方案已由用户取消，不属于本次功能，也未写入应用代码。

### 文件与测试

| 用途 | 路径（仓库相对） |
| --- | --- |
| 首条 multipart 请求 | `frontend/apps/widget/src/api/index.js` |
| 首条附件入口、上传状态与草稿 | `frontend/apps/widget/src/components/MessageInput.vue`、`MessageInputActions.vue` |
| 初始化和后续上传处理 | `cmd/chat.go`、`cmd/widget_upload.go` |
| 主动邀请附件回复 | `cmd/widget_campaign_reply.go`、`internal/conversation/proactive.go` |
| 附件存储与消息插入 | `internal/conversation/message.go` |
| 组件回归 | `frontend/apps/widget/src/components/MessageInput.test.js` |
| 上传校验回归 | `cmd/widget_upload_test.go` |
| 端到端回归 | `frontend/cypress/e2e/integration/livechat/firstAttachment.cy.js`、`config.cy.js` |

## 同步上游的方法

目标是保留上游改进和上述定制行为，而不是永久冻结这些文件。GitHub 提示冲突时需要按语义合并；维护记录不能保证今后永远没有冲突。

1. 读取本记录，检查工作区和远程地址，保留未提交工作。先记录同步前的 fork HEAD SHA，供后续通过 Git 历史回溯。
2. 基于最新 `origin/main` 合并原项目 `main`。复杂同步需要隔离时，可创建临时 `codex/sync-upstream-日期` 分支。记录本次上游 SHA。
3. 逐段解决冲突，检查以上行为与调用链，不能整文件盲选 ours/theirs。不要用重置到上游、丢弃 fork 提交或强制推送作为常规同步办法。
4. 即使没有文本冲突，也运行下方回归。若上游已提供等价功能，可适配或移除重复实现，并保留行为与测试，避免执行两遍。
5. 验证后按当前任务的发布要求合入 fork `main`；需要发布时等待 GHCR 构建和镜像验证成功。更新本记录的同步日志、路径及替代提交。确认临时分支已合入后，删除其本地及 fork 远程分支，最终仅保留 `main`。

需要临时分支时的命令示意，`YYYYMMDD` 应替换为本次同步日期，重复同步时另加唯一后缀。在仓库目录执行；先确保工作区干净，并保存输出的同步前与上游提交 SHA：

```sh
git status --short
git remote -v
# 仅在 upstream 不存在时添加；已有时先核对它是否指向原项目。
git remote add upstream https://github.com/abhinavxd/libredesk.git
git fetch origin
git fetch upstream
git switch -c codex/sync-upstream-YYYYMMDD origin/main
git rev-parse HEAD upstream/main
git merge --no-ff upstream/main
```

记录建立时只有 `origin`；2026-11-13 首次同步时已添加 `upstream`，指向上表中的原项目。若需退出尚未完成的合并，可使用 `git merge --abort`；不要丢弃用户工作。上述命令仅准备合并，不会自动发布。[Git 合并冲突处理文档](https://git-scm.com/docs/git-merge)

## 用户要求同步上游后的回归清单

本节只用于上游同步，不作为日常功能修改和发布的全量检查要求。

- [ ] 自动化表单仍能保存“会话更新 + 收到消息 + 内容包含优惠券 + 固定回复123456”。
- [ ] 首条消息、后续匹配消息、重新打开的会话行为正确；不匹配、空文本、自动发送消息不误触发或循环。
- [ ] 展开和折起的触屏都默认底部直接输入；输入区空白点击、草稿、发送正常。
- [ ] 键盘高度变化及仅 visual viewport 变化不更换编辑器节点；聊天记录、发送按钮仍可见。
- [ ] 展开状态下将 PWA 切到后台再恢复，根布局重新对齐顶部并使用恢复后的高度；列表内部位置、输入焦点与草稿保留，捏合缩放不被重置。浏览器模拟通过后仍需真机复测系统恢复行为。
- [ ] 手动全屏往返保留草稿；桌面焦点、收起偏好、邮件和附件正常。
- [ ] 访客首条可直接发附件；取消或无效文件不创建会话，上传成功保留文字草稿，失败可重试，后续消息沿用同一会话。
- [ ] 保留并运行上述单元和 Cypress 回归；通过现有 `Go` 与五分片 `CI` 工作流后发布本次上游同步。
- [ ] 发布后核对镜像 revision/version 与本次功能提交相符，确认 `latest` 指向新镜像。

本地定向检查（依赖版本以 `go.mod`、`frontend/package.json` 和锁文件为准；Go 数据库集成测试需要 PostgreSQL 与 `LIBREDESK_TEST_DB_DSN`，Cypress 需要运行中的后端和测试服务，可参照现有工作流配置）：

```sh
go test ./internal/automation ./internal/conversation
cd frontend
pnpm test:run
pnpm exec cypress run --e2e --spec "cypress/e2e/ui/automationForm.cy.js,cypress/e2e/integration/livechat/keywordAutomation.cy.js,cypress/e2e/ui/touchReplyComposer.cy.js"
```

同步验证所需环境不足时，以配置好依赖的 GitHub Actions 完成该同步的检查。建档时的功能基线已通过 Go、71 个前端单元测试文件（1,118 项测试）、五分片 Cypress，以及 WebKit 触屏组件检查；这不替代以后用户要求同步上游时的验证。

## 相关发布配置也需保留

这两项功能依靠 fork 自己的镜像发布。同步 `.github/workflows` 时一并检查：

- [44791e8b](https://github.com/ikun2020/libredesk/commit/44791e8b23a0835ae3a3d8bdcc91a1e0a9bdca83)：`.github/workflows/docker.yml` 发布到 `ghcr.io/ikun2020/libredesk`；`latest`/`main` 跟随本 fork 默认分支。原上游发布工作流有仓库限制。
- [8e13ad54](https://github.com/ikun2020/libredesk/commit/8e13ad545da61e27f580eeace416972530e6ad69)：从上游标签解析应用版本并附加 Git 提交信息，避免 fork 构建退回 `v0.0.0` 后产生错误更新提示；保留镜像版本冒烟检查。
- 部署应使用 fork 的 GHCR 镜像；上游 `docker-compose.yml` 的默认 Docker Hub 镜像不包含这些定制。

## 同步日志

### 2026-11-14：桌面消息发送快捷键

- 桌面会话回复、私密备注及新建邮件正文使用 `Enter` 发送，`Shift+Enter` 换行；桌面消息框的旧 `Ctrl+Enter` 发送绑定移除，提示与快捷键帮助同步更新。
- 通过显式 `sendOnEnter` 开关仅在上述消息框且非 coarse 主指针时开启。手机/DUO、知识库文章、宏、自动化及联系人备注编辑器保留原有换行行为。
- `MessageSend` 在 @ 提及和 # 会话候选处理 Enter 后才发送；保留 Esc 关闭候选后发送，并避免输入法确认和按键重复导致误发。键盘发送遵守上传中、发送中及空回复限制。
- 回归：`messageSendExtension.test.js` 检查真实编辑器按键及候选选择，`ReplyBoxContent.test.js` 检查设备开关与发送限制。

| 日期 | 结果 |
| --- | --- |
| 2026-11-13 | 建立两项定制维护记录；功能基线 `a08ec969`，本次未执行上游同步。 |
| 2026-11-13 | 从 fork `2fc1999c` 合并上游 `0c6fae86`（PR #823，锁定的 `vue-letter` 从 0.2.2 升级到 0.2.3）。无文本冲突；两项定制代码、回归测试和 GHCR 工作流均保持原样。同步分支 `codex/sync-upstream-20261113`；同步前本地备份 `codex/backup-before-sync-20261113`。 |
| 2026-11-13 | 按用户澄清，仅在明确要求 fork sync 时进行上游冲突检查及定制保留核查；日常修改仍做正常必要验证，不套用同步清单。长期仅保留 `main`，停止保留备份分支。 |

## 2026-11-14：XBoard 同步安全协议与插件 1.1.0

- 接入说明见 [XBOARD_SECURITY.md](XBOARD_SECURITY.md)。插件最终入口按用户要求为 `/api/v1/support-sync/loader.js?v=1.1.0`；使用同源随包脚本，不采用默认远程脚本自动适配或独立远程引导方案。
- 保留邮箱及余额、已用流量、总流量、到期时间、套餐同步和原 `site_id:用户ID` 联系人。新增每个面板登录范围的十分钟认证租期、独立退出能力、原子撤销与重放拦截；旧收件箱认证会话一次性迁移，不删除联系人/聊天。
- WebSocket 收发检查撤销状态；后台恢复重新签发身份时保留同账号草稿，换号/退出忽略迟到响应。插件不采集网址/标题，通用访问记录过滤查询参数与片段，错误日志去除凭据。
- 后续升级须保留安全握手和 `/chat/security`、`/chat/auth/revoke`、`/chat/auth/revoke-legacy` 协议及对应 Go/Vitest 回归。未更改触屏编辑器、关键词自动回复和桌面 Enter 发送行为。

## 2026-11-14：用户 fork sync 与轻量资料接口发布

- 用户在 GitHub 执行的合并为 `9c1c90f2736d846ccc3fa20bf96881b21d1fdc76`，父提交分别是本 fork 的轻量资料接口 `9abe298557f49d47b7845ef06879a1a3b1514d35` 与上游 `2d0617d79932d45f2b1cc8c538d7efe8be73b448`。随后 `495e01ec` 为 Go/前端 CI 增加手动触发入口，方便发布前验证。
- 逐项核对上游 48 个文件改动：自动回复消息快照、iPhone 正常流视口补偿、桌面 Enter、首附件发送、签名会话撤销与轻量访客身份隔离均保留。共同 SQL 文件保留上游客服排序改进和轻量资料更新的 visitor 类型、启用状态、外部身份约束。
- 轻量版接入说明见 [XBOARD_LITE.md](XBOARD_LITE.md)。只更新当前随机凭据所属访客的邮箱及允许的属性，不按邮箱合并身份；资料来自浏览器，仅供参考。签名版接口继续保留。
- 合并后完整前端回归使用 [五分片 CI](https://github.com/ikun2020/libredesk/actions/runs/43565876276)，对应应用代码 `495e01ec`。首次 Go 数据库回归发现测试收件箱缺少 `from` 字段，授权逻辑执行前就扫描失败；本次仅补齐测试数据并提前检查其可读性，不改变应用逻辑，保留全部权限及持久化断言。
- 最终发布在修正后的提交上手动运行 Go/PostgreSQL 工作流；待 Go 和上述五分片前端全部成功，再手动发布同一提交的 GHCR 镜像并核对 revision、容器版本和 latest。提交中的 `[skip ci]` 只控制自动推送任务，避免验证完成前自动更新 latest，不豁免手动测试。
- 原有未提交的重定向修正保留在工作区，未混入本次发布。未创建临时分支；本地与 fork 继续仅保留 main。浏览器回归不代表新增的 iPhone 真机后台恢复验证。
