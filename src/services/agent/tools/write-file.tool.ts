/**
 * write_file — 写入或修改项目文件
 */
import { t } from '../../../shared/locale'
import { buildAgentTool } from '../tool-registry'
import { createToolIpc } from '../tool-ipc'
import { useProjectStore } from '../../../stores/project-store'
import { isProtectedRelativePath, validatePath } from './safe-path'
import { clearReadState } from './read-file.tool'
import { computeTextStats } from '../../text-stats'
import { useEditorStore } from '../../../stores/editor-store'
import { isVelaProtocol, VELA } from '../../vela-protocol'
import { resolveAgentFilePath } from '../agent-file-resolver'

export const writeFileTool = buildAgentTool({
  name: 'write_file',
  description: t('tool.writeFileDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: t('tool.writeFilePath'),
      },
      content: {
        type: 'string',
        description: t('tool.writeFileContent'),
      },
    },
    required: ['file_path', 'content'],
  },
  requiresConfirmation: true,
  isReadOnly: false,
  reconcile: async (args, context) => {
    const toolIpc = createToolIpc(context)
    const project = useProjectStore.getState().currentProject
    if (!project || context.signal.aborted || (context.scope && context.scope !== project.path) || typeof args.content !== 'string' || typeof args.file_path !== 'string') return undefined
    const path = resolveAgentFilePath(args.file_path)
    let actual: string | undefined
    let target = path
    if (path.startsWith(VELA.DRAFT)) {
      const rawId = path.slice(VELA.DRAFT.length)
      if (!/^\d+$/.test(rawId)) return undefined
      actual = (await toolIpc.invoke('db:draft-get-full', Number(rawId)))?.content
    } else {
      if (isVelaProtocol(path)) return undefined
      const check = validatePath(project.path, path)
      if (!check.valid || isProtectedRelativePath(check.relativePath)) return undefined
      target = check.fullPath
      const result = await toolIpc.invoke('fs:read-file', target)
      if (!result.success) return undefined
      actual = result.content
    }
    if (context.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path || actual !== args.content) return undefined
    return { success: true, executionState: 'committed', content: '已只读核验实际内容与原写入一致；不重复写入。', persistence: { target, verified: true, projectPath: project.path } }
  },
  execute: async (args, context) => {
    const toolIpc = createToolIpc(context)
    if (context?.signal.aborted) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消' }
    const filePath = args.file_path as string
    const content = args.content as string

    if (!filePath || content === undefined) {
      return { success: false, content: '', error: t('error.missingFilePathContent') }
    }

    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: t('error.noProject') }
    }
    const resolvedPath = resolveAgentFilePath(filePath)

    // vela://draft/{id}：数据库草稿直接 CAS 写，不导出成物理文件
    if (isVelaProtocol(resolvedPath)) {
      if (!resolvedPath.startsWith(VELA.DRAFT)) {
        return {
          success: false,
          content: '',
          error: resolvedPath.startsWith(VELA.MANUSCRIPT) ? t('tool.draftReadonly') : t('tool.unsupportedProtocol'),
        }
      }
      const rawId = resolvedPath.slice(VELA.DRAFT.length)
      if (!/^\d+$/.test(rawId)) return { success: false, content: '', error: t('tool.draftNotFound') }
      const draftId = Number(rawId)
      const openTab = useEditorStore.getState().tabs.find(x => x.filePath === resolvedPath || x.id === resolvedPath)
      if (openTab?.dirty) return { success: false, content: '', error: t('tool.draftDirty') }
      const full = await toolIpc.invoke('db:draft-get-full', draftId)
      if (context?.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path || (context?.scope && context.scope !== project.path)) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消或项目已切换，未提交' }
      if (!full) return { success: false, content: '', error: t('tool.draftNotFound') }
      if (full.status === 'finalized') return { success: false, content: '', error: t('tool.draftReadonly') }
      const res = await toolIpc.invoke('db:draft-apply-content', {
        draftId,
        expectedHash: full.contentHash,
        expectedUpdatedAt: full.updatedAt,
        content,
        wordCount: computeTextStats(content).novelWordCount,
      })
      if (!res.success) {
        if (res.conflict) return { success: false, content: '', error: t('tool.draftConflict') }
        return { success: false, content: '', error: res.error ?? t('tool.writeFileFailed') }
      }
      clearReadState(filePath)
      const tab = useEditorStore.getState().tabs.find(x => x.filePath === filePath || x.id === filePath)
      if (!context?.signal.aborted && useProjectStore.getState().currentProject?.path === project.path && tab) {
        try {
          if (tab.inlineSession) useEditorStore.getState().endInlineSession(tab.id)
          useEditorStore.getState().markTabSaved(tab.id)
          useEditorStore.getState().syncTabContent(tab.id, content)
        } catch (error) { console.warn('[write_file] 已提交，编辑器刷新失败', error) }
      }
      return {
        success: true,
        executionState: 'committed',
        content: t('tool.fileWritten').replace('{path}', filePath).replace('{length}', String(content.length)),
        artifacts: [{ type: 'file_modified', path: resolvedPath, name: filePath }],
      }
    }

    // 路径安全校验
    const pathCheck = validatePath(project.path, resolvedPath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: pathCheck.error }
    }

    // ⚠️ 数据文件保护：拒绝写入项目内部数据目录（.novelforge/.vela 含 SQLite 库/向量库/白名单、
    // .git/、node_modules）——一次误写即可用文本覆盖二进制 DB，损坏整个项目（P0 修复）。
    // 判定对象 = validatePath 产出的**规范化相对路径**（首段 ∈ 数据目录）——原始 LLM 串的
    // './.novelforge/x'、'x/../.novelforge/x' 等混淆形态经 resolveSafeRelativePath 归一化后必命中（I-1）
    if (isProtectedRelativePath(pathCheck.relativePath)) {
      return { success: false, content: '', error: t('tool.writeProtectedPath') }
    }

    if (context?.signal.aborted || useProjectStore.getState().currentProject?.path !== project.path || (context?.scope && context.scope !== project.path)) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消或项目已切换，未提交' }
    const result = await toolIpc.invoke('fs:write-file', pathCheck.fullPath, content)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? t('tool.writeFileFailed') }
    }

    // ⚠️ 写盘成功后失效读去重缓存（P0-2）：LLM「写盘 → 重读验证」是 ReAct 常见模式，
    //    不清除则重读仍命中桩，LLM 无法确认写入结果
    clearReadState(pathCheck.fullPath)  // key 与 read_file 项目内分支的 pathKey（validatePath.fullPath）一致

    return {
      success: true,
      executionState: 'committed',
      content: t('tool.fileWritten').replace('{path}', filePath).replace('{length}', String(content.length)),
      artifacts: [{ type: 'file_modified', path: pathCheck.fullPath, name: filePath }],
    }
  },
})
