<div align="center">

# 🔥 NovelForge — AI 小说创作 IDE

**AI 深度驱动的小说创作集成开发环境，为网文作者而生。**

[![React](https://img.shields.io/badge/React-19-blue.svg)](https://reactjs.org/)
[![Electron](https://img.shields.io/badge/Electron-41-black.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6.svg)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/Version-0.1.7--beta.3-orange.svg)](package.json)
[上游 CI（不代表本版本）](https://github.com/LunaRime/novelforge/actions/workflows/build.yml)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-yellow.svg)](https://opensource.org/licenses/GPL-3.0)

[🇨🇳 中文] &nbsp; [🇬🇧 English](README.en.md)

</div>

---

> **NovelForge** 是一款开源、隐私优先的 AI 写作 IDE。将大语言模型驱动的全流程工作流与本地 RAG 知识库深度融合，为作者提供 IDE 级别的沉浸式创作体验。支持 **zh-CN / en-US / ru-RU** 三语界面。

## 本仓库说明

本仓库是基于 [LunaRime/novelforge](https://github.com/LunaRime/novelforge) 的独立修改版本，不是上游官方仓库，也不声称拥有全部代码的原创归属。保留上游署名及 GNU GPL v3 许可证。来源、修改范围与分发说明见 [衍生版本声明](NOTICE.md)。

### 本版本修改（2026-11-04）

- **Windows 打包修复**：通过 `afterPack` 资源处理补齐 EXE 图标、版本信息并检查 ASAR 完整性资源；预建 NSIS 安装包输出子目录，修复输出文件无法创建的问题。该资源处理路径不提供应用 EXE 自动签名，不能替代正式签名流程。
- **项目重命名**：增加当前项目改名入口，同步数据库项目名称、最近项目列表及界面显示；不移动项目目录。
- **定稿退回草稿**：增加确认操作，让已定稿的数据库正文恢复为可编辑草稿；保留正文、版本与已有后处理结果，不代表撤销知识库、记忆或角色更新。
- **Agent 工作流虚报修复**：对“已启动／已完成”等常见工作流声明核对本轮工具回执和真实任务状态，未证实的声明撤回并纠正；任务卡片关联 `runId`、展示真实状态并跳转对应输出；按项目保存最近 50 条工作流历史；空正文或数据库保存失败不再报告保存成功。

上述内容属于本修改版本，不应理解为上游已合并或已发布。打包改动有专项测试，但完整安装包及安装后的运行仍需单独验证。

---



---

## 🗺️ 它是怎么运转的

![NovelForge 架构](screenshots/architecture.zh.png)

> 作者 → 界面层 → IPC 安全桥 → 创作引擎 → 模型服务；**章节、设定、向量索引全部留在本机**，只有模型请求出网。
> 图由 [archify](https://github.com/tt-a1i/archify) 从 `docs/diagrams/novelforge-architecture.zh.json` 生成（英文版见 [README.en.md](README.en.md)）。

## 📸 界面截图

| 主编辑界面（中文） | 主编辑界面（英文） |
|-------------------|-------------------|
| ![中文界面](screenshots/main-editor-zh.png) | ![英文界面](screenshots/main-editor-en.png) |

| 欢迎页 | 角色管理 |
|----------|-----------|
| ![欢迎页](screenshots/welcome-zh.png) | ![角色管理](screenshots/characters-zh.png) |

| 模型与供应商配置（中文） | 设置界面（英文） |
|----------|-----------|
| ![设置](screenshots/settings-zh.png) | ![英文设置](screenshots/settings-en.png) |

---

## ✨ 核心特性

### 🧬 AI 小说创作全流程

| 能力 | 说明 |
|---|---|
| 世界观与设定管理 | 全局世界观、剧情主轴、角色人设档案（跨章动态追踪） |
| 自动大纲与细纲生成 | AI 生成结构骨架 → 章节细纲 → 场景/情绪/节奏要求 |
| 大纲自动拆章 | AI 分析大纲自动建议章节数、分卷结构和高潮章号 |
| 流式章节正文生成 | 单章流式打字机生成，精准响应前文上下文 |
| 章节过渡引擎 | 写稿前提取前3章场景卡片注入 prompt，确保连贯性 |
| 段落级改写 | 扩写/缩写/改风格/增强冲突/润色五种模式，非全文重写 |
| 编辑部协作审阅 | 5 角色并行评审（主编/情节/文案/连续性/风格）+ 加权评分 |
| 角色声音一致性 | 定稿后分析角色对话风格，写稿时自动注入保持一致性 |
| 多稿对比择优 | 同章并行生成多版本，AI 自动评分选出最佳 |
| 伏笔管理器 | 自动扫描新伏笔 + 检测回收旧伏笔，防止遗忘 |
| 后期管线 | 正文入库 → 剧情提取 → 角色更新 → 伏笔扫描 → 声音分析 → 文风学习（DAG 并行） |
| 撤销/重做 | Ctrl+Z/Y 快捷键 + 工具栏按钮，CodeMirror 6 原生支持 |
| 多语言 Prompt 模板 | 内置模板英/俄双语（19 模板 + 系统约束 + 角色定位），输出语言自动跟随界面语言 |

### 📊 写作数据看板

| 能力 | 说明 |
|---|---|
| 每日活动热力图 | GitHub Contribution 风格全年视图，悬停查看单日写作/修改/调用/费用 |
| 月度趋势柱状图 | 全年 12 个月写作趋势，年份切换查看往期 |
| 全局统计 | 跨项目聚合写作字数 / 修改量 / 模型调用 / Tokens / 费用 |

### 🔍 可观测性

| 能力 | 说明 |
|---|---|
| 双环境日志流 | 开发（DEBUG 全量）与发布（INFO 起）分目录；渲染进程日志落盘 + 全局错误捕获 |
| LLM 提取日志 | 调用/JSON 解析/自检重试全过程可见，解析失败完整诊断落盘 |
| 保存行为反馈 | 所有保存操作 toast 视觉反馈 + 模块化日志（Save:{Module}） |

### 🧠 百万字级本地知识库 + 向量引擎

| 能力 | 说明 |
|---|---|
| LLM+向量融合检索 | 语义搜索 + 全文检索混合，自动注入 AI prompt |
| LLM 向量化 | 将 LLM 作为向量模型使用，无需专用 Embedding API |
| 本地向量模型 | 可接本地 Ollama（bge-m3 等），无网也能语义检索；四级降级链 本地 ⇄ 云端 API → LLM → 全文检索 |
| 中文检索 | jieba 分词 + FTS 全文索引，中文检索不再退化为整句匹配 |
| IVF_PQ 向量索引 | LanceDB ANN 索引加速大规模向量检索 |
| 纯本地存储 | SQLite + LanceDB，断网可用 |

### 💭 AI 记忆（作品记忆）

| 能力 | 说明 |
|---|---|
| 三级摘要 | 定稿即生成章节记忆 → 卷内章节齐全后聚合卷记忆 → 每满 3 卷重建全书状态 |
| 跨会话事实 | 会话压缩时顺带提取「可复用事实」，下次对话自动带上，不额外花钱 |
| 失效与重建 | 改分卷边界、重定稿会把受影响的记忆标记为「待重建」，陈旧记忆不再进上下文 |
| 可查可改 | 侧栏「AI 记忆」组可查看 / 编辑 / 删除，卷与全书支持手动重建 |

### 💰 成本优化引擎

| 能力 | 说明 |
|---|---|
| 分层模型路由 | elite/standard/budget 三层自动路由，节省 50-70% |
| Prompt 缓存 | API 自动缓存命中，输入费用降低 50% |
| 实时费用追踪 | StatusBar 实时显示会话费用 |
| Token 预算引擎 | 智能截断，系统提示词上限控制 |

### 🤖 AI Agent 助手

| 能力 | 说明 |
|---|---|
| 执行证据与完成核验 | 文字回复不等于执行；配置完成声明核对当前轮具体字段的已验证回执，缺证据时纠正或标记未验证；工作流启动不等于最终完成 |
| 配置写入闭环 | 更新绑定项目路径、检查记录并逐字段回读，以实际保存值同步界面 |
| 连续执行与安全预算 | 取消固定 8 步中断；默认每项用户任务最多 100 次模型请求，可在设置调整为 16–1000；父子 Agent 与恢复重试共享预算。重复调用无新结果时先提醒调整策略，仍无进展才停止，保留执行记录、不回滚已有操作 |
| 原生工具协议 | OpenAI／Anthropic／Gemini 结构化工具调用与结果配对，保留结束原因；异常 EOF／截断／损坏参数不执行本步工具，兼容 XML／DSML 文本模式 |
| 人工批准与后台提醒 | 设置可选 2／10／30 分钟或不限批准等待，默认 10 分钟；人工等待不占子 Agent 与父 task 工具执行时限。窗口最小化、隐藏或失焦时，批准请求及工作流步进等待触发系统通知和任务栏闪烁，系统提示音可关闭；点击只定位、不自动批准，提醒受系统通知及勿扰设置影响 |
| 取消与安全重试 | 取消贯穿审批与执行；超时后的写入状态未知时先核对，不盲重试。停止等待不等于撤销已提交操作 |
| 执行记录与恢复 | 工具终态独立归档，保存状态区分待保存／已保存／失败；无正文工具消息也可恢复，未明确完成的 Agent 调用不自动重放 |
| 工作流工具调用 | Agent 通过 `start_workflow` 发起创作任务并取得运行回执；任务卡区分未验证、部分失败、耗尽与取消 |
| 对话分支 | 任意消息 fork 派生新会话 / rewind 回退可恢复，历史面板分支层级标注 |
| 工具结果写盘引用 | 长工具结果全文落盘按需再读，上下文只进路径 + 摘要（确定性命名 + 写盘防重） |
| 自适应上下文压缩 | 压缩预算按模型窗口动态化，可恢复错误自动降档重试（withhold-then-recover） |
| 工具与技能 | 内置读写／检索／编辑／工作流工具 + SKILL.md 技能包（内置 / 用户 / 项目三级，兼容 Cursor 生态） |
| MCP | 接入任意 MCP 服务器扩展工具面 |
| 上下文可视化 | 占用圆环 + 明细弹层（基础 / 记忆 / 历史 / 当前），费用与缓存命中率实时可见 |
| 退出保存保障 | Agent 与独立工作流共同等待收尾和保存；失败或超时提示并留窗，晚到成功不会自动关闭 |

可靠性判断仍有边界：完成声明识别不是通用自然语言逐项验收，原生协议不保证所有中转模型都支持，取消／超时也不代表外部副作用已撤销。当前实现已收尾，用户本机反馈最新类型检查及退出专项测试无错误；完整最新全仓、构建与隔离 Electron 关闭／重启验收尚未明确全部确认。

技术分层、调用／结果协议、执行证据、未知状态核对、归档恢复及退出机制见 [Agent 架构与执行可靠性](docs/architecture-review.md#agent-架构与执行可靠性当前实现)。本轮也调整了独立工作流、数据库／IPC、网络／MCP、知识库及应用退出等共享模块，不仅是 Agent 面板变化。

### 🛡️ 安全加固

| 能力 | 说明 |
|---|---|
| Electron 沙箱 | `sandbox: true` + IPC 通道白名单 + 路径沙箱 |
| API 密钥加密 | Electron safeStorage 加密存储 |
| LLM 指数退避重试 | 429/503/5xx 自动重试 + 流式重试 |
| 数据库完整性 | SQLite PRAGMA 检查 + 时间字段统一 + CHECK 约束 |

---

## 🚀 安装

### 📦 上游预构建版本

[上游 Releases](https://github.com/LunaRime/novelforge/releases) 提供上游安装包，**不包含本仓库修改**。本修改版本请从当前仓库源码构建；如后续提供安装包，应同时链接该安装包对应源码。上游产物以实际发行附件为准：
- **Windows**: `NovelForge-{version}-Installer.exe`（NSIS 安装程序）
- **Windows**: `NovelForge-{version}-Portable.zip`（绿色便携版，解压即用）

### 🔨 源码构建

#### 环境要求

| 工具 | 版本 | 说明 |
|------|------|------|
| **Node.js** | `>= 22.x` | Electron 41 内置版本 |
| **pnpm** | `>= 9.x` | 包管理器（项目使用 pnpm workspace） |
| **Python** | `>= 3.10` | 编译 `better-sqlite3` / `lancedb` 等原生模块 |
| **C++ 工具链** | — | Windows: Visual Studio Build Tools · macOS: Xcode CLT · Linux: `build-essential` |

#### 快速开始

从**当前仓库**克隆或下载源码，然后进入项目根目录。不要用上游克隆地址替代当前仓库，否则得到的源码不包含上述修改。当前仓库托管地址确定后，可通过仓库页面的克隆入口获取地址。

```bash
# 在已取得的当前仓库源码根目录中执行

# 2. 安装依赖（使用 pnpm）
pnpm install

# 3. 开发模式（Vite HMR 热更新）
pnpm run dev

# 4. 类型检查
pnpm run typecheck

# 5. 运行测试
pnpm run test

# 6. 完整构建（Windows 下需设置镜像环境变量加速下载）
npm_config_user_agent="pnpm/9.15.4" \
CSC_IDENTITY_AUTO_DISCOVERY=false \
ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/" \
pnpm run build
```

> **构建环境变量说明**：
> - `npm_config_user_agent` — 强制 electron-builder 识别 pnpm 包管理器
> - `CSC_IDENTITY_AUTO_DISCOVERY=false` — 跳过代码签名（本地构建无需证书）
> - `ELECTRON_BUILDER_BINARIES_MIRROR` — npmmirror 镜像加速（国内网络必需，避免 GitHub 下载超时）
>
> 构建产物按版本类型归位到 `release/{type}/{version}/`（`alpha` 内测 / `beta` 公测 / `stable` 正式版）：
> - `NovelForge-{version}-Portable/` — 绿色便携版（beta/stable 自动附带 `.7z` 压缩包）
> - `NovelForge-{version}-Installer/NovelForge-{version}-Installer.exe` — NSIS 安装程序
> - `latest.yml` / `.blockmap` — electron-updater 自动更新元数据

#### 开发者控制台与隔离实例

仅开发态可用（打包版需 `--devtools` 启动，或在「设置 → 开发者选项」启用）：

- **应用内**：`Ctrl+K` → 开发者控制台；或「设置 → 开发者选项 → 打开开发者控制台」。
  面板包含：隔离实例、IPC 调用指标、Agent 运行、模型表现、项目数据库（只读）、日志、性能。
- **CLI**（隔离 HOME + 独立项目 + 独立 CDP 端口，不污染当前项目）：

```bash
# 只开开发者控制台，不打开项目
node scripts/dev-instance.mjs start --dev-console --json

# 带项目启动；列出 / 远程打开控制台 / 执行 JS / 截图 / 停止 / 清理
node scripts/dev-instance.mjs start --project /tmp/nf-test --json
node scripts/dev-instance.mjs list
node scripts/dev-instance.mjs console-ui <id>
node scripts/dev-instance.mjs eval <id> 'document.title'
node scripts/dev-instance.mjs shot <id> /tmp/nf-shot.png
node scripts/dev-instance.mjs stop <id>
node scripts/dev-instance.mjs clean <id> --yes
```

实例数据位于 `~/.novelforge/dev-instances/<id>/`（manifest / 隔离 HOME / 日志）。

#### 构建卡点（Windows）

| 卡点 | 解决方案 |
|------|---------|
| winCodeSign 7z symlink 下载失败 | 手动下载解压到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/` |
| NSIS 7z symlink 下载失败 | 同上，解压到 `%LOCALAPPDATA%/electron-builder/Cache/nsis/` |
| pnpm 包管理器未检测 | 设置 `npm_config_user_agent=pnpm/9.15.4` |
| GitHub 下载慢/超时 | 设置 `ELECTRON_BUILDER_BINARIES_MIRROR` 镜像 |

#### 原生模块说明

项目依赖 `better-sqlite3` 和 `@lancedb/lancedb` 两个原生模块：

```bash
# 针对 Electron 内置 Node 版本重新编译原生模块
pnpm run rebuild
```

---

## ⚙️ 模型配置

支持 `OpenAI` · `DeepSeek` · `Gemini` · `Claude` · `Ollama` · `智谱 GLM` · 任何 OpenAI 兼容 API。

- **供应商账户**：一份凭据挂多个模型 —— 添加供应商后**自动拉取其可用模型列表**，勾选即可用，切换模型不用重新填密钥
- **分层路由**：三代三层（创意写作 / 标准分析 / 轻量处理）各自指定模型，省钱且不牺牲质量
- **本地向量模型**：可在应用内一键下载（多路径自动测速选路 + 断点续传 + 慢时自动换路）

---

## 🏗️ 技术架构

| 层 | 技术栈 |
|----|--------|
| 前端 | React 19 + TypeScript + Zustand + Tailwind CSS + Radix UI |
| 桌面 | Electron 41 + Vite 8 |
| 数据 | better-sqlite3 (关系型) + LanceDB (向量) |
| AI | OpenAI / Anthropic / Gemini Protocol + MCP + ReAct Agent（结构化工具调用与执行证据核验） |
| 测试 | Vitest + Storybook |
| CI/CD | GitHub Actions (ubuntu/windows/macos 矩阵) |

---

## 📄 协议

沿用上游 GNU GPL v3 许可证，完整文本见 [LICENSE](LICENSE)。直接上游为 [LunaRime/novelforge](https://github.com/LunaRime/novelforge)；其 README 另记载 [Vela / heider-x](https://github.com/heider-x/vela) 为更早来源。本仓库保留这些署名，但未独立核实最初原创作者和完整贡献历史。详见 [衍生版本声明](NOTICE.md)。

本修改版本独立维护，不代表上游官方发行。分发二进制时，应同时提供该版本对应源码及必要构建脚本，并保留适用的版权、许可和无担保声明。

---

<div align="center">
<b>NovelForge — Forge your novel with AI.</b>
</div>
