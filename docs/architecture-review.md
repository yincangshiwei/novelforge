# NovelForge 技术架构与框架检查记录

> 文档说明：Agent 架构与执行可靠性说明更新于 2026-11-09，描述当前工作区实现；原框架审查与修复记录保留作为历史基线，其中规模数字、迁移版本与测试数量不代表本轮现状。

> 检查范围：主进程（main/preload/ipc-handlers/controllers/repositories/LLM/MCP/utils/health-check）、渲染进程（App/main.tsx/stores/services/components/shared）、构建（vite.config/electron-builder）、安全（CSP/sandbox/IPC 白名单）、工程化脚本。
> 规模基线：主进程 ≈7.6k 行（controllers 15 个 3245 / repositories 14 个 2025 / llm 745 / mcp 534 / utils 1022）；渲染进程 ≈50k 行（stores 3651 / services 18719 / components 22629 / shared 4778）。

---

## Agent 架构与执行可靠性（当前实现）

### 目标与分层

Agent 使用 ReAct 循环规划和调用工具，但模型文字不是执行证明。曾出现模型零工具调用却声称配置已补充的情况；本轮改造将「生成结束、工具提交、实际回读、业务完成、记录保存」分开处理。用户使用开发模式，旧生产构建缓存不是此次问题根因。

**模型负责规划，执行器负责操作，系统依据执行证据判断完成。**

| 层级 | 职责与主要入口 |
| --- | --- |
| 交互与会话 | `src/stores/agent-store.ts` 管理轮次、流式文字、审批、子任务、保存状态；`AgentMessage.tsx` 展示文字／工具块和任务终态 |
| 编排与证据 | `agent-engine.ts` 组织步骤和工具批次；`execution-evidence.ts` 核对当前轮声明；`tool-history.ts` 配对历史调用／结果 |
| 工具执行 | `tool-registry.ts` 定义工具及执行上下文；`tool-execution.ts` 管理取消、超时和未知门禁；`tool-ipc.ts` 将子操作发送到受控 IPC |
| 模型协议 | `llm-store.ts` → `llm-controller.ts` → OpenAI／Anthropic／Gemini Provider；共享结构化步骤与流事件协议贯穿调用 ID、结束原因及元数据 |
| IO 与提交证明 | 主进程 `agent-operation-controller.ts` 安全分派，`agent-operation-journal.ts` 先记录执行意图；控制器／repository 完成 DB、文件或外部调用 |
| 保存与恢复 | `archive-queue.ts`、`archive-codec.ts`、`conversation-recovery.ts`、`operation-recovery.ts` 保存快照并恢复执行事实；工作流另有 checkpoint |

上表中的 Agent 文件位于 `src/services/agent/`，Provider 位于 `electron/llm/`，操作控制器与日志分别位于 `electron/controllers/`、`electron/services/`。业务编排留在渲染进程，真正 IO 和持久提交在主进程完成。

### 正常执行链路

1. **准备轮次**：登记会话、轮次与取消控制器，准备提示词、检索上下文和历史；准备等待也检查取消，旧返回不能启动新轮次或替换已取消历史。
2. **请求模型**：发送工具定义及成组历史。模型步骤返回文字、工具调用、调用 ID、结束原因及终止信号；纯工具响应不触发空回复重复请求。
3. **验证协议**：截断、异常 EOF、损坏参数等不能执行本步工具或当作正常结束。原生协议默认启用；`ModelProfile.nativeToolCalling: false` 使用保留的 XML／DSML 文本兼容路径。
4. **审批与执行**：工具按只读／写入性质分批；审批、批次开始、批准后和真正调用前检查取消。工具上下文携带 `signal`、`turnId`、`step`、`callId`、`operationId`、项目范围及会话 ID。
5. **保存执行意图**：写工具执行前等待归档屏障；主进程操作日志先 claim，再分派 IO。归档明确失败时不启动该写工具，不将零执行误标为未知提交。
6. **记录回执**：回执携带目标、结果与验证信息。配置更新绑定项目路径，检查影响行数并逐字段回读，界面采用实际保存值。
7. **核对声明**：配置完成声明必须匹配当前轮相应字段的成功且已验证回执；缺证据时自动纠正一次，仍不足则撤回或标记未验证。工作流保留原核验；启动 `runId` 不等于工作流最终完成。
8. **保存终态**：每个工具终态触发归档，历史保留调用／结果配对和失败事实；生成结束与任务状态分离，子 Agent 不将未验证、部分失败、耗尽或取消当成功。

### 执行状态、超时与重试

| 状态／事实 | 系统含义 |
| --- | --- |
| 未启动／确定未提交 | 有执行前取消或明确回滚证明；不能声称写入已发生 |
| `committed` | 操作提交或已通过受支持的实际状态核对；不代表整个自然语言任务已完成 |
| `unknown` | 已启动但没有确定结论；超时／取消仅停止等待，不证明未写入或已撤销 |
| 已提交但原响应不可用 | 外部副作用事实与原响应正文分开；不能为取得响应再次盲调用 |
| `pending/saved/failed` | 归档保存状态，与上述业务执行状态独立 |

主进程日志对同操作 ID 单飞，用严格规范 JSON 参数指纹拒绝冲突，并阻止同资源仍在运行／未知时的新写入。同步数据库业务写与提交 marker 同事务；明确回滚保留业务失败与冲突信息，重启后据提交证明核对。

遇到未知写入，执行层优先复用晚到的确定结果，或调用工具的只读 `reconcile` 查询实际状态。核对使用独立操作／取消身份，避免与原写入的子操作 ID 或取消墓碑冲突；确认未提交后才允许以新调用身份重试。没有足够核对证据时保持门禁，不自动重放。

取消传递到可中断的 LLM、网络、MCP、嵌入等底层；不可撤销的已提交操作不会被描述为撤销。普通 `ipc.invoke` 有 30 秒等待超时，但不会因此终止主进程副作用。嵌入／Ollama 的部分入口另有覆盖请求与响应消费的整体 deadline，不应扩大为所有网络路径都已覆盖。

### 工具历史、时间线与压缩

- 原生调用与结果成组回放和预算选择，保留调用 ID、失败事实与 Gemini 签名；文本兼容模式保留事实但不发送原生 `tool` 角色。
- 新消息保存有序文字／工具块；旧消息先按原文切分再清洗思考／计划文字，避免原始偏移失效。后处理改写全文可能重排为工具块加全文，并非完整细粒度事件日志。
- CCR 摘要取消贯穿实际模型请求；晚到返回或读取后取消不继续写学习配置／共享记忆。分卷读取可取消，写前再次检查；已发出的分卷写回执晚到不替换取消轮次的历史或裁剪旧原文。

### 归档与中断恢复

`ArchiveQueue` 将同会话快照串行写入，区分快照版本和真实保存完成；调度保存不等于 flush。失败保留最新快照供重试，主进程检查成功回执并使用不易碰撞的临时文件名称。

工具完成但最终总结尚未返回时，归档仍保留工具证据；无正文的 tool-only 消息不丢弃。恢复将 `pending/running/waiting_confirm` 等未结束调用归一为中断／未知，消息不保持假流式状态，未明确完成调用不自动执行。

恢复还查询会话操作日志：已有调用用确定提交事实纠正，已知子调用归属到对应子会话，孤儿日志仅补会话级证据，不推断父／子任务已完成。Agent 未完成工作流恢复为暂停；独立旧工作流保留部分原有自动恢复策略，二者不能混称。

### 应用退出协调

- `src/main.tsx` 的 `__vela_flushAgentArchives` 经 `close-coordinator.ts` 同时协调 Agent 与独立工作流，整体同步禁入，防一侧先完成后新任务逃出保存检查。
- 两侧 `prepareForClose` 各自后台单飞：取消、等待旧任务、刷尾文、保存、flush。重复关闭只等待同一个尚未完成的 drain，不重复执行写入。
- `close-deadline.ts` 为 store 等待设置 30 秒时限；主进程保存握手有 35 秒兜底。失败、拒绝或超时均保留窗口提示，只有明确 `true` 才放行。
- 超时返回不丢弃后台任务，也不将 `pending` 改为 `saved`；晚到成功不会自动关闭窗口，需用户显式重试。失败后整体 gate 可释放，仍未结束的一侧保持自身禁入；成功后保留整体 gate 到退出，再次显式关闭重新核验。
- dirty 检查只处理编辑器／角色未保存内容，与执行记录保存屏障是两项独立检查；选择丢弃编辑不能跳过执行记录核验。

### 本轮范围、验证与设计边界

本轮可靠性改造分三阶段：P0 执行证据与配置回读，P1 原生工具协议／历史／终态，P2 取消／超时／日志／恢复／退出。并非仅修改 Agent 内部：数据库／IPC 提供提交保障，独立工作流修复取消尾文与 checkpoint，知识库提供 chunks 替换及运行期回滚，MCP／嵌入／网络贯穿取消，应用退出由两侧共同确认。规划角色提示词与测试基础设施也有联调修正。

实现已收尾落盘，用户本机反馈最新类型检查及退出专项测试无错误；未提供最新完整汇总与退出码。最新全仓回归、构建、fresh 隔离 Electron 关闭／重启和真实模型 API 未被明确全部验收，不沿用下文历史测试数量。主进程／preload 改动需要重启 `pnpm run dev`；旧构建不可用作新源码验收。

不作为已完成承诺的能力：

- 通用自然语言逐项验收：声明识别仍受正则／语言覆盖限制，落库一致不代表用户要求全部满足。
- 通用 exactly-once、取消即撤销、所有路径别名／跨通道资源识别；未知文件写入仍有保守阻断及解除协议边界。文件内容相同不证明该操作曾提交。
- 配置严格 CAS、原子合并／追加与撤销；草稿冲突检查不能代替配置 CAS。
- 原生工具能力 UI、真实探测与安全自动回退；协议实现不等于所有中转模型支持。
- 全链路实时事件日志和未知孤儿子会话精确归属。
- LanceDB 多表原子事务及所有 KB 写路径安全：替换是运行期可恢复过程，崩溃／回滚失败仍可能未知。

---

## 历史框架审查

以下章节保留原框架审查与该批次修复记录；其中 P0/P1/P2 是原审查的问题分级，不是上文 Agent 可靠性实施阶段。

## 一、总体结论

**框架整体健康、分层清晰、防护意识强——属于"中型项目里架构纪律很好的样本"。** 核心评价：

1. **Electron 分层正确**：主进程只做 IO（DB/文件/网络/进程），业务编排（工作流/命令/Agent）放渲染进程 services——避免主进程阻塞 UI 的正确选择；
2. **IPC 设计是本项目最扎实的部分**：preload 前缀白名单（编译时派生类型）+ `ipc-channels.ts` 统一签名 + `ipc-client` 30s 超时/浏览器降级 + 主进程错误归一化；
3. **数据层严谨**：WAL + integrity_check + 损坏自动备份 + `user_version` 幂等迁移（v15）+ 事务合并；
4. **工程化成熟**：verify-contract → tsc → vite → electron-builder → verify-packed-app → organize-release 全链门禁，启动计时/错误落盘/双环境日志俱全。

发现的框架级问题集中在**安全（生产 CSP 缺失）与规范一致性（i18n 漏网）**，另有若干可维护性优化点——详见下文分级。

---

## 二、架构分层（现状）

```
┌─ 渲染进程（sandbox: true, contextIsolation: true, nodeIntegration: false）──┐
│  React 19 + Zustand（17 store）                                               │
│    stores（3651 行）→ 组件状态/持久化                                         │
│    services（18719 行）→ 业务编排：workflows/commands、agent、prompts、audit  │
│    components（22629 行）→ panels/editor/dialogs/settings/ui                  │
│        │ ipc.invoke('db:...') 类型安全                                         │
├─ Preload（白名单 20 前缀 invoke / 3 前缀 event）──────────────────────────────┤
│        │ ipcRenderer.invoke                                                     │
├─ 主进程（Node，CJS）──────────────────────────────────────────────────────────┤
│  controllers（15 个）→ ipcMain.handle 注册 + 错误归一化                        │
│  repositories（14 个）→ better-sqlite3 / LanceDB 数据访问                       │
│  llm / mcp / utils / health-check                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **动态 import 是循环依赖的既定解法**（workflow/archive 多处 `await import()`）——有效且已形成模式；
- **EventBus 解耦**跨模块通知（REFRESH_RESOURCE / WORKFLOW_COMPLETE）——避免 store 直接互相调用；
- **启动链路有计时埋点**（HTML_READY / T0 / 模块加载耗时），LanceDB 懒加载。

---

## 三、问题清单（按优先级）

### 🔴 P0 — 安全

**P0-1 生产环境实际没有 CSP（深度防御缺口）**
- `main.ts` 通过 `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP——该机制只对 **HTTP 响应头**生效；
- 生产模式 `win.loadFile(file://)` 不产生 HTTP 响应头 → **CSP 注入不生效**（注释也承认"此处仅影响 dev 模式"）；
- `index.html` **没有 CSP meta 标签** → 生产环境 `script-src` 无限制。
- 已有防护：sandbox + contextIsolation + nodeIntegration:false + preload 白名单（核心防线在）。但 CSP 是 XSS 的第二道防线，缺失使「渲染进程被注入脚本 → 调用任意 db:/fs: 通道」的风险面放大。
- 修复：`index.html` 加 CSP meta（需处理两处内联脚本——主题检测/启动计时；方案：`'unsafe-inline'` 妥协 或 迁移到外部 chunk + `script-src 'self'` 严格模式；Electron 支持 meta CSP）。

### 🟠 P1 — 规范一致性（i18n）

**P1-1 health-check.ts 8 处硬编码中文未走 t()**
- `'数据库未连接' / '数据库完整' / 'LLM 服务可达'` 等——这些 message 经 `health:check` IPC 直达渲染进程展示，违反「所有用户可见文本必须走 t()」核心约束。
- 修复：8 处替换为 `t()` 键（三语），成本极低。

**P1-2 跨层 i18n 残留风险**
- 已抽查的 controller/repository 均走 t()；建议以「electron 层字符串字面量」为审计目标补一次全量扫描（health-check 是已确认的漏网点，可能还有同类）。

### 🟡 P2 — 可维护性

**P2-1 controller 层 try/catch 样板重复**
- 15 个 controller × 每个 handler 都是 `try { repo.x(); return {success:true} } catch { return {success:false, error} }` 四行样板。
- 建议：提取 `wrapHandler(fn)` 统一包装（约省 40% controller 行数），纯机械重构、低风险。

**P2-2 巨型文件开始出现**
- `SettingsModal.tsx` 51KB / `CharacterEditor.tsx` 37KB / `workflow-utils.ts` 36KB / `finalize-chapter.command.ts` 31KB / `EditorArea.tsx` 32KB。
- 当前仍有清晰分区（可读），但继续增长会到拆分阈值；建议后续按「设置分组组件 / 命令提取纯函数」渐进拆分，不必现在动。

**P2-3 repository 写接口返回风格不统一**
- 部分方法 throw（controller catch），部分静默（mergeFields 无行时不报）——语义可接受，但建议注释/命名约定统一（如 `updateX` throw、`tryX` 返回结果）。

### 🟢 做得扎实、不需要动的部分

| 项 | 说明 |
|----|------|
| IPC 白名单 + 类型派生 | 前缀机制 + as const 联合类型，新增通道编译期约束 |
| 30s IPC 超时 + 浏览器降级 | ipc-client 双保险 |
| 关闭前 dirty 检查 | 主进程 executeJavaScript 查询 `__vela_hasDirtyTabs`（含角色 dirty） |
| 数据库生命周期 | 损坏备份/重建 + WAL checkpoint + 版本降级哨兵 |
| 渲染错误落盘 | installRendererErrorCapture → render-logger |
| 构建门禁链 | verify-contract/verify-packed-app/organize-release 脚本 |
| chunk 分割 | vendor-react / vendor-editor / vendor-ui / vendor |
| 双环境日志 | dev 全量 DEBUG / 发布 INFO，按版本号自动识别 |
| 主进程崩溃兜底 | render-process-gone → 提示 + reload |

---

## 四、建议路线

1. **P0-1（安全，1 天内）**：index.html 补 CSP meta（严格模式优先，内联脚本迁移或 hash 放行）——生产防护补上最后一块；
2. **P1-1（规范，30 分钟）**：health-check 8 处走 t() + 全量扫描 electron 层字符串字面量；
3. **P2（渐进）**：wrapHandler 抽取（可与 1/2 同批）、巨型组件后续按需拆分；
4. 维持现状：分层/白名单/迁移体系/构建链均无需改动。

> 一句话结论：**框架骨架无需重构——当前最值得做的是补生产 CSP（真实安全缺口）与 i18n 漏网清理（规范一致性），其余是渐进式优化。**

---

## 五、修复状态（分点修复记录）

| 编号 | 问题 | 状态 | 落地位置 |
|------|------|------|----------|
| P0-1 | 生产环境无 CSP | ✅ 已修 | `index.html` 加 CSP meta（`script-src 'self'` 严格模式，`%VITE_CSP_SCRIPT%` 按模式替换：dev='unsafe-inline' / 生产='self'）；两个内联脚本外移 `public/theme-init.js`（主题+启动页 i18n）与 `public/startup-timer.js`（启动计时）；`vite.config.ts` 函数式配置注入占位；`main.ts` webRequest CSP 保留（dev 兜底，注释更新）。已用生产构建验证：meta 替换为 `'self'`、外移脚本进入 dist/ |
| P1-1 | health-check 硬编码中文 | ✅ 已修 | 11 处 → `t()`（`health.*` 13 键三语，含磁盘空间/LLM 状态动态文本） |
| P1-2 | electron 层 i18n 漏网 | ✅ 已修 | 全量扫描修复：`mcp-manager` SSE 错误、`browser-controller` 6 处（未启用/端口/连接失败）、`embedding-service` 4 处（进度 step 3 + 双重试错误 1）；新增 `browser.*`/`embedding.*`/`mcp.sseNotImplemented` 键三语 |
| P2-1 | controller try/catch 样板 | ⏳ 未做 | 机械重构面大，按报告建议后续渐进（不阻塞本轮） |
| P2-2 | 巨型文件 | ⏳ 未做 | 有清晰分区，按报告结论暂不拆分 |

> 门禁：typecheck 零错误、lint 零警告、525 测试全过、`vite build` 成功且产物 CSP 验证通过。
