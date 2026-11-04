# 衍生版本与来源声明 / Derivative Version Notice

声明日期 / Notice date: 2026-11-04

## 中文声明

### 来源与署名

本仓库是基于 [LunaRime/novelforge](https://github.com/LunaRime/novelforge) 的独立修改版本。这里将该仓库列为直接上游来源，并保留其已有署名、版权、许可及免责声明；不将上游全部代码或功能归为本仓库维护者原创。

上游 README 另记载：“原始项目 Vela by heider-x，由 LunaRime 持续开发维护”，并链接到 [heider-x/vela](https://github.com/heider-x/vela)。本声明保留这一来源记录，但未独立核实最初原创作者、完整派生关系及全部贡献历史。仓库名称相同、fork 数量或仓库所有者名称，均不作为原创归属的证明。

本版本不是上游官方发行版。上游作者与贡献者的署名不代表其对本版本修改提供维护、背书或担保。直接上游的基准提交或下载版本尚未核实；当前本地包版本号为 `0.1.7-beta.3`，该版本号不能替代准确的上游提交标识。

### 本版本修改

以下源码修改日期为 2026-11-04；详细功能说明见 [README.md](README.md)。

1. 修复 Windows EXE 资源处理和 NSIS 安装包输出目录问题。新增资源处理 hook，保留并校验 ASAR 完整性及非目标资源。该路径不自动签名应用 EXE；完整安装包与安装运行需另行验证。
2. 增加当前小说项目重命名入口，同步数据库、最近项目列表与界面名称，不移动项目目录。
3. 增加已定稿数据库正文“退回草稿”功能，保留正文和历史版本，不撤销已有定稿后处理。
4. 修复 Agent 无工具调用却宣称已启动工作流的问题：增加常见执行声明核验、真实任务状态与结果关联、项目级工作流历史持久化、空草稿和数据库保存失败校验，以及执行期间的项目隔离保护。

上述清单描述本版本修改，不是整个项目的原创功能清单，也不表示上游已合并这些改动。个人小说数据库修复、备份、聊天记录和本机工作记忆不是源码发布内容。

### 许可证与分发

沿用上游 GNU General Public License Version 3，完整文本见 [LICENSE](LICENSE)。本声明仅补充来源和修改信息，不替代或修改许可证，也不限制许可证已授予的权利。

分发本修改版本时，应保留适用的版权、许可和无担保声明，并醒目标明修改事实与日期。分发安装包或其他二进制时，应依许可证提供该二进制所对应的完整源码及必要构建脚本；未经修改的上游源码不能代替本版本对应源码。第三方组件继续适用各自的许可声明。

当前 README 中的上游发行链接只提供上游版本，不包含本版本改动。本仓库的实际托管地址和发行地址尚未填写；发布前应核对克隆地址、CI 徽章、`electron-builder.json5` 发布目标及对应源码入口。不要把修改版本误发布到上游仓库或将其标为上游官方版本。

## English Notice

This repository is an independently modified derivative of [LunaRime/novelforge](https://github.com/LunaRime/novelforge), identified here as the direct upstream source. Existing attribution, copyright, licensing, and warranty notices are retained. The maintainer of this derivative does not claim original authorship of the entire codebase.

The upstream README also credits [Vela by heider-x](https://github.com/heider-x/vela). This notice preserves that provenance statement without independently confirming the earliest original author, the complete derivation chain, or all contributors. Identical repository names, fork counts, and repository ownership do not establish original authorship.

This is not an official upstream release. Upstream attribution does not imply endorsement, support, or warranty for these modifications. The exact upstream baseline commit or downloaded release has not been verified; the local package version `0.1.7-beta.3` is not a substitute for that identifier.

Modifications dated 2026-11-04 include Windows executable-resource and NSIS output-directory fixes, project renaming, returning finalized database text to draft without undoing post-processing, and Agent workflow-claim verification with actual task status/output links, per-project workflow history, draft-save validation, and project isolation. These changes do not imply upstream acceptance. Personal novel databases, backups, conversations, and local assistant memories are not part of this source distribution.

The upstream GNU GPL Version 3 license is retained; see [LICENSE](LICENSE). This notice supplements attribution and change information and does not replace the license or restrict rights it grants. Binary distributions must be accompanied by access to their corresponding source and necessary build scripts under the license. Unmodified upstream source alone is not the corresponding source for this derivative. Third-party notices remain applicable.

Upstream release links in the README do not include these local changes. Before publishing, verify this repository's clone and release URLs, CI badge, publishing configuration, and corresponding-source links. Do not publish this derivative as an official upstream release.
