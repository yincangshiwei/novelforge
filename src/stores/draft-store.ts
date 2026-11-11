/**
 * 草稿状态管理 — 管理各章节草稿列表、定稿操作等
 *
 * 数据来源：drafts/ch{N}/index.json（md+json 分离方案）
 * .md 文件保持纯正文，元数据全部由 index.json 管理
 */
import { create } from 'zustand'
import { VELA } from '../services/vela-protocol'
import { computeTextStats } from '../services/text-stats'
import { ipc } from '../services/ipc-client'
import {
  updateDraftStatus as updateDraftStatusInIndex,
  type DraftMeta,
} from '../services/draft-index'
import type { DraftStatus } from '../shared/draft-status'
import { getDraftDir } from '../services/workflows/chapter-workflow'
import { useProjectStore } from './project-store'
import { useWorkflowStore } from './workflow-store'
import { globalEventBus } from '../shared/event-bus'
import { useEditorStore } from './editor-store'
import { errorMessage } from '../shared/error-diagnostics'
import { t } from '../shared/locale'

// ===== 类型定义 =====

/** 单章下的草稿列表（key = chapterNumber） */
export type DraftsByChapter = Record<number, DraftMeta[]>

interface DraftState {
  /** 各章草稿列表（内存缓存），key = chapterNumber */
  draftsByChapter: DraftsByChapter
  /** 是否正在加载 */
  loading: boolean

  // ===== Actions =====
  /** 重置为初始状态（项目关闭时由 ProjectService 调用） */
  reset: () => void
  /** 加载某章的所有草稿 */
  loadChapterDrafts: (chapterNumber: number) => Promise<void>
  /** 加载全部章节草稿（扫描 drafts/ 目录下所有 ch{NNN} 子目录） */
  loadAllDrafts: () => Promise<void>

  /** 手动标记草稿状态（修稿/审稿后更新用） */
  markDraftStatus: (draftPath: string, chapterNumber: number, status: DraftStatus) => Promise<void>
  /** 仅将已定稿的数据库正文恢复为草稿，不撤销文件或知识库后处理 */
  returnToDraft: (draftPath: string, chapterNumber: number) => Promise<{ success: boolean; error?: string }>
  deleteArchivedDraft: (draftPath: string, chapterNumber: number) => Promise<{ success: boolean; error?: string }>
  /** 清除指定章节的缓存（下次访问时重新加载） */
  invalidateChapter: (chapterNumber: number) => void
  /** 应用合并后的修稿，更新文件和各类状态 */
  applyMergedRevision: (
    chapterDir: string,
    chapterNumber: number | undefined,
    filePath: string,
    revPath: string,
    mergedText: string
  ) => Promise<{ success: boolean; error?: string }>
}

// 草稿加载请求序号（loadAllDrafts 防跨项目切换竞态）
let draftLoadSeq = 0
const pendingReturns = new Set<string>()

export const useDraftStore = create<DraftState>()((set, get) => ({
  draftsByChapter: {},
  loading: false,

  reset: () => {
    set({ draftsByChapter: {}, loading: false })
  },

  loadChapterDrafts: async (chapterNumber) => {
    const project = useProjectStore.getState().currentProject
    if (!project) return

    try {
      // 直接调用后端 DB 获取列表，返回的结构已经转换为兼容的 DraftMeta 格式
      const list = await ipc.invoke('db:draft-list', chapterNumber)
      const metas: DraftMeta[] = list.map((m) => ({
        ...m,
        status: m.status as DraftStatus,
        source: m.source as DraftMeta['source'],
        fileName: `draft_v${m.version}.md`,
        filePath: `${VELA.DRAFT}${m.id}`
      }))

      // 按版本号排序（新 → 旧）
      metas.sort((a, b) => b.version - a.version)

      set(s => ({
        draftsByChapter: { ...s.draftsByChapter, [chapterNumber]: metas },
      }))
    } catch {
      // 出错或不存在时跳过
    }
  },

  loadAllDrafts: async () => {
    const project = useProjectStore.getState().currentProject
    if (!project) return

    // 请求序号：项目快速切换时旧项目的慢响应不得覆盖当前项目数据
    const seq = ++draftLoadSeq
    set({ loading: true })
    try {
      // 获取所有有草稿的章节号（不仅限有蓝图的章节，导入流程先建草稿后推演蓝图）
      const chapterNums: number[] = await ipc.invoke('db:draft-get-all-chapter-numbers')
      const newDraftsByChapter: DraftsByChapter = {}

      for (const chNum of chapterNums) {
        const list = await ipc.invoke('db:draft-list', chNum)
        if (!list || list.length === 0) continue

        const metas: DraftMeta[] = list.map((m) => ({
          ...m,
          status: m.status as DraftStatus,
          source: m.source as DraftMeta['source'],
          fileName: `draft_v${m.version}.md`,
          filePath: `${VELA.DRAFT}${m.id}`
        }))

        metas.sort((a, b) => b.version - a.version)
        newDraftsByChapter[chNum] = metas
      }

      if (seq !== draftLoadSeq) return // 已被更新的加载请求取代（项目已切换）
      set({ draftsByChapter: newDraftsByChapter })
    } finally {
      if (seq === draftLoadSeq) set({ loading: false })
    }
  },


  markDraftStatus: async (draftPath, chapterNumber, status) => {
    // 新路径：vela://draft/{id} → 直接解析真实 id（归档/状态更新走 DB）
    if (draftPath.startsWith(VELA.DRAFT)) {
      const idRaw = draftPath.replace(VELA.DRAFT, '')
      if (/^\d+$/.test(idRaw)) {
        const result = await ipc.invoke('db:draft-update-status', parseInt(idRaw, 10), status)
        if (!result.success) throw new Error(result.error || '草稿状态更新失败')
        await get().loadChapterDrafts(chapterNumber)
        return
      }
    }

    // 旧路径兼容：draft_v{N}.md → 经 draft-index（已 DB 桥接）更新
    const versionMatch = draftPath.match(/draft_v(\d+)\.md$/)
    if (!versionMatch) return
    const version = parseInt(versionMatch[1])
    const project = useProjectStore.getState().currentProject
    if (!project) return
    const chapterDir = getDraftDir(project.path, chapterNumber)
    await updateDraftStatusInIndex(chapterDir, version, status)
    // 重新加载该章草稿以刷新缓存
    await get().loadChapterDrafts(chapterNumber)
  },

  returnToDraft: async (draftPath, chapterNumber) => {
    const match = draftPath.match(/^vela:\/\/(?:draft|manuscript)\/(\d+)$/)
    const id = match ? Number(match[1]) : NaN
    const project = useProjectStore.getState().currentProject
    if (!project || !Number.isSafeInteger(id) || id <= 0) {
      return { success: false, error: '无效的数据库草稿或未打开项目' }
    }
    const requestKey = `${project.path}:${id}`
    if (pendingReturns.has(requestKey)) return { success: false, error: '正在退回草稿，请勿重复提交' }
    pendingReturns.add(requestKey)
    try {
      const meta = await ipc.invoke('db:draft-get-meta', id)
      if (!meta || meta.id !== id || meta.chapterNumber !== chapterNumber || meta.status !== 'finalized') {
        return { success: false, error: '草稿不存在、章节不匹配或已不处于定稿状态，请重新打开确认' }
      }
      if (useProjectStore.getState().currentProject !== project) {
        return { success: false, error: '项目已切换，请重新打开确认' }
      }
      // 工作流可能在确认弹窗或元数据查询期间启动，写入前再次检查。
      if (useWorkflowStore.getState().activeRuns.length > 0) {
        return { success: false, error: '工作流执行期间不能退回草稿' }
      }
      const result = await ipc.invoke('db:draft-update-status', id, 'draft')
      if (!result.success) return { success: false, error: result.error ?? '退回草稿失败' }
      // 状态已提交：只更新元数据，绝不覆盖正文、版本或任何脏页签。
      if (useProjectStore.getState().currentProject === project) {
        set(s => ({
          draftsByChapter: {
            ...s.draftsByChapter,
            [chapterNumber]: (s.draftsByChapter[chapterNumber] ?? []).map(d => d.id === id ? { ...d, status: 'draft' } : d),
          },
        }))
        // ProjectService 加载全部草稿；正式稿列表和工作台也使用同一缓存。
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'] })
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    } finally {
      pendingReturns.delete(requestKey)
    }
  },

  deleteArchivedDraft: async (draftPath, chapterNumber) => {
    const match = draftPath.match(/^vela:\/\/draft\/(\d+)$/)
    const id = match ? Number(match[1]) : NaN
    const project = useProjectStore.getState().currentProject
    if (!project || !Number.isSafeInteger(id) || id <= 0) return { success: false, error: '无效的数据库草稿或未打开项目' }
    const key = `delete:${project.path}:${id}`
    if (pendingReturns.has(key)) return { success: false, error: '正在删除，请勿重复提交' }
    pendingReturns.add(key)
    try {
      const meta = await ipc.invoke('db:draft-get-meta', id)
      if (!meta || meta.chapterNumber !== chapterNumber || meta.status !== 'archived') return { success: false, error: '草稿不存在或不是已归档版本' }
      if (useProjectStore.getState().currentProject !== project) return { success: false, error: '项目已切换，请重新确认' }
      if (useWorkflowStore.getState().activeRuns.length) return { success: false, error: '请先停止工作流再永久删除草稿' }
      const drafts = get().draftsByChapter[chapterNumber] ?? []
      const paths = new Set(drafts.flatMap(d => [d.filePath, d.filePath.replace('vela://draft/', 'vela://manuscript/')]))
      paths.add(draftPath)
      const open = useEditorStore.getState().tabs.some(tab => tab.chapterNumber === chapterNumber || paths.has(tab.filePath ?? '') || paths.has(tab.id))
      if (open) return { success: false, error: t('draftbox.deleteOpenTab') }
      const result = await ipc.invoke('db:draft-delete', id, chapterNumber)
      if (result.success && useProjectStore.getState().currentProject === project) {
        set(s => ({ draftsByChapter: { ...s.draftsByChapter, [chapterNumber]: (s.draftsByChapter[chapterNumber] ?? []).filter(d => d.filePath !== draftPath) } }))
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['drafts'] })
      }
      return result
    } catch (error) { return { success: false, error: errorMessage(error) } }
    finally { pendingReturns.delete(key) }
  },

  invalidateChapter: (chapterNumber) => {
    set(s => {
      const next = { ...s.draftsByChapter }
      delete next[chapterNumber]
      return { draftsByChapter: next }
    })
  },

  applyMergedRevision: async (chapterDir, chapterNumber, filePath, revPath, mergedText) => {
    try {
      const { markRevisionMerged } = await import('../services/draft-index')
      if (/^\d+$/.test(revPath)) {
        const revision = await ipc.invoke('db:revision-get-full', Number(revPath))
        if (revision?.auditReport) {
          const audit = JSON.parse(revision.auditReport) as { baseContentHash?: string }
          if (audit.baseContentHash) {
            const full = await ipc.invoke('db:draft-get-full', revision.baseDraftId)
            const { reviewContentHash } = await import('../services/review-actions')
            if (!full || await reviewContentHash(full.content) !== audit.baseContentHash) throw new Error(t('review.staleReport'))
            if (useEditorStore.getState().tabs.some(tab => tab.filePath === filePath && tab.dirty)) throw new Error(t('tool.draftDirty'))
          }
        }
      }

      const versionMatch = filePath.match(/v(\d+)/)
      const version = versionMatch ? parseInt(versionMatch[1]) : 1

      // 统一"有效字数"口径（汉字 + 英文单词）
      const mergedWordCount = computeTextStats(mergedText).novelWordCount

      let targetDraftId: number | undefined
      // 统一通过 DB 更新草稿内容
      if (filePath.startsWith(VELA.DRAFT) || filePath.startsWith(VELA.MANUSCRIPT)) {
        const prefix = filePath.startsWith(VELA.DRAFT) ? VELA.DRAFT : VELA.MANUSCRIPT
        targetDraftId = parseInt(filePath.replace(prefix, ''))
        const updated = await ipc.invoke('db:draft-update-content', targetDraftId, mergedText, mergedWordCount)
        if (!updated.success) throw new Error(updated.error)
      } else {
        // 从 filePath 解析 chapterNumber 和 version，查出 draftId 再更新
        const chMatch = filePath.match(/ch(\d+)/)
        const chNum = chMatch ? parseInt(chMatch[1]) : chapterNumber
        if (chNum !== undefined) {
          const drafts = await ipc.invoke('db:draft-list', chNum)
          const target = (drafts as unknown as Array<Record<string, unknown>>).find((d) => d.version === version)
          if (target) {
            targetDraftId = target.id as number
            const updated = await ipc.invoke('db:draft-update-content', targetDraftId, mergedText, mergedWordCount)
            if (!updated.success) throw new Error(updated.error)
          }
        }
      }

      // 更新草稿状态为 revised（直接调用 DB，不走 legacy index）
      if (targetDraftId && version) {
        await ipc.invoke('db:draft-update-status', targetDraftId, 'revised', mergedWordCount)
      }

      // 标记修稿为已合并（旧版文件索引才有 revPath；DB 化后 diff Tab 不传，跳过即可）
      const revFileName = revPath.split('/').pop() || ''
      const origFileName = targetDraftId ? targetDraftId.toString() : (filePath.split('/').pop() || '')
      if (revFileName && chapterDir) {
        await markRevisionMerged(chapterDir, revFileName, origFileName)
      }

      if (targetDraftId) {
        try {
          const { auditRefinement } = await import('../services/audit/refinement-audit')
          const meta = await ipc.invoke('db:draft-get-meta', targetDraftId)
          const report = await auditRefinement(mergedText, targetDraftId, meta?.version)
          const { reviewContentHash } = await import('../services/review-actions')
          const reportContent = JSON.stringify({ ...report, scope: 'merged_draft', revisionId: revPath, baseContentHash: await reviewContentHash(mergedText) })
          const reviewIndex = await ipc.invoke('db:review-next-index', targetDraftId)
          const saved = await ipc.invoke('db:review-create', { baseDraftId: targetDraftId, reviewIndex, content: reportContent })
          if (!saved.success || !saved.id) throw new Error(saved.error)
          globalEventBus.emit('REFRESH_RESOURCE', { resources: ['reviews'] })
          useEditorStore.getState().openFile({
            id: `merged-audit-${targetDraftId}-${saved.id}`,
            name: `${t('audit.mergedReport')} · ${t('editor.reviewLabel').replace('{version}', String(meta?.version ?? version)).replace('{index}', String(reviewIndex))}`,
            type: 'review-report',
            content: reportContent,
            chapterNumber,
            reportPath: `${VELA.REVIEW}${saved.id}`,
          })
        } catch (error) {
          console.warn(t('audit.refinementUnchecked'), error)
        }
      }

      // 同步到编辑器（需通过 filePath 查找对应 tab 的 id）
      const editorState = useEditorStore.getState()
      const targetTab = editorState.tabs.find(t => t.filePath === filePath)
      if (targetTab) {
        editorState.syncTabContent(targetTab.id, mergedText)
        editorState.markTabSaved(targetTab.id)
      }

      if (chapterNumber !== undefined) {
        await get().loadChapterDrafts(chapterNumber)
      }
      useProjectStore.getState().refreshFileTree()

      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  },
}))

// ===== 辅助工具导出 =====

/**
 * 读取草稿文件正文（委托给 vela-protocol 统一路由）
 * @deprecated 建议直接使用 readVelaContent()
 */
export async function readDraftBody(filePath: string): Promise<string> {
  const { readVelaContent } = await import('../services/vela-protocol')
  return readVelaContent(filePath)
}

export type { DraftMeta, DraftStatus }
