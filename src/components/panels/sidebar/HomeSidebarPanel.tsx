/**
 * HomeSidebarPanel — 主页侧边栏：项目管理入口 + 当前项目信息 + 最近项目
 *
 * 历史项目方块列表已提升为 Sidebar 直接子级（常驻底部），不在此渲染。
 * 2026-09-28：欢迎页的「最近项目」列表迁入本视图（行片形态，过滤当前项目）；
 * 按钮列在「打开项目」下方新增「导入小说」入口（= 既有 ImportNovelDialog）。
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookOpen, Clock, Trash2 } from 'lucide-react'
import { useAgentStore } from '../../../stores/agent-store'
import { useWorkflowStore } from '../../../stores/workflow-store'
import { useCharacterStore } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { toast } from '../../ui/Toast'
import { useProjectStore } from '../../../stores/project-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { ipc } from '../../../services/ipc-client'
import { Button } from '../../ui/Button'
import MenuRow from '../../ui/MenuRow'
import { alertError, confirmDeleteProject } from '../../ui/Confirm'
import { useTranslation } from '../../../hooks/useTranslation'

export default function HomeSidebarPanel() {
  const { t } = useTranslation()
  const currentProject = useProjectStore(s => s.currentProject)
  const openProject = useProjectStore(s => s.openProject)
  const recentProjects = useProjectStore(s => s.recentProjects)
  const deleteProjectFolder = useProjectStore(s => s.deleteProjectFolder)
  const removeRecentProject = useProjectStore(s => s.removeRecentProject)
  const [transferring, setTransferring] = useState(false)
  useEffect(() => {
    if (!transferring) return
    const blockKeys = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation() }
    window.addEventListener('keydown', blockKeys, true)
    return () => window.removeEventListener('keydown', blockKeys, true)
  }, [transferring])

  const transfer = async (mode: 'export' | 'restore') => {
    if (transferring) return
    if (useProjectStore.getState().loading || useAgentStore.getState().generating || useWorkflowStore.getState().hasActiveRun() || useCharacterStore.getState().saving) {
      toast.warning(t('workflow.projectBusy'))
      return
    }
    if (useEditorStore.getState().tabs.some(tab => tab.dirty) || useCharacterStore.getState().dirty) {
      toast.warning(t('package.unsaved'))
      return
    }
    setTransferring(true)
    try {
      const agent = useAgentStore.getState()
      const saved = await Promise.all(agent.conversations.map(c => agent.persistCurrent(c.id)))
      if (saved.some(ok => !ok) || !await agent.flushArchives() || !await useWorkflowStore.getState().flushCheckpoint()) throw new Error(t('package.saveFailed'))
      if (mode === 'export') {
        if (!await useProjectStore.getState().saveProject()) throw new Error(t('package.saveFailed'))
        const result = await ipc.invoke('project:export-package')
        if (result.cancelled) return
        if (!result.success) throw new Error(result.error)
        toast.success(t('package.exported').replace('{path}', result.path ?? ''))
        if (result.warnings?.length) await alertError(result.warnings.join('\n'), { title: t('package.export') })
      } else {
        const result = await ipc.invoke('project:restore-package')
        if (result.cancelled) return
        if (!result.success || !result.projectPath) throw new Error(result.error)
        toast.success(t('package.restored').replace('{path}', result.projectPath))
        await openProject(result.projectPath)
        await useAgentStore.getState().restoreArchives()
        if (result.warnings?.length) await alertError(result.warnings.join('\n'), { title: t('package.restore') })
      }
    } catch (error) {
      await alertError(String(error), { title: t(mode === 'export' ? 'package.export' : 'package.restore') })
    } finally { setTransferring(false) }
  }

  // 最近项目：排除当前项目（与 LT 栏方块列表同口径——上方已有「当前项目」卡，重复出现只是占位）
  const recentTargets = recentProjects.filter(p => p.path !== currentProject?.path)

  /** 删除/移出最近项目（复用既有两步确认；行片内按钮为兄弟节点，无需 stopPropagation） */
  const handleDelete = async (path: string) => {
    const action = await confirmDeleteProject()
    if (action === 'delete') await deleteProjectFolder(path)
    else if (action === 'remove') await removeRecentProject(path)
  }

  return (
    <div className="px-3 py-2 text-sm">
      {transferring && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label={t('package.busy')}>
          <div className="rounded-lg p-6 text-sm" style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text)' }}>
            <p role="status">{t('package.busy')}</p>
          </div>
        </div>, document.body,
      )}
      {/* 当前项目信息 */}
      {currentProject && (
        <div
          className="mb-3 px-3 py-2.5 rounded-lg"
          style={{ backgroundColor: 'var(--color-hover)' }}
        >
          <div className="flex items-center gap-2">
            <span
              className="flex-shrink-0 w-2 h-2 rounded-full"
              style={{ backgroundColor: 'var(--color-accent)' }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
                {currentProject.name}
              </p>
              <p className="text-micro truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {t('project.current')}</p>
            </div>
          </div>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex flex-col gap-1.5 mb-3">
        <Button
          variant="default"
          className="w-full"
          onClick={() => useLayoutStore.getState().openNewProject()}
        >
          {t('dialog.newProject')}</Button>
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            const folder = await ipc.invoke('dialog:select-folder')
            if (folder) {
              openProject(folder)
            }
          }}
        >
          {t('action.openProject')}</Button>
        {/* 导入小说（= 既有 ImportNovelDialog；与欢迎页第三个大按钮同源） */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => useLayoutStore.getState().openImportNovel()}
        >
          {t('welcome.importNovel')}</Button>
        {currentProject && (
          <Button variant="outline" className="w-full" disabled={transferring} onClick={() => void transfer('export')}>
            {t('package.export')}
          </Button>
        )}
        <Button variant="outline" className="w-full" disabled={transferring} onClick={() => void transfer('restore')}>
          {t('package.restore')}
        </Button>
        <p className="text-micro px-1" style={{ color: 'var(--color-text-muted)' }}>{t('package.hint')}</p>
      </div>

      {/* 最近项目（2026-09-28 自欢迎页迁入）——行片形态（MenuRow 为唯一实现）；
          行间距由片自带的 `margin: 2px 4px` 承担（spec 片间距 2px），容器不得再加 space-y-* */}
      {recentTargets.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Clock size={12} style={{ color: 'var(--color-text-muted)' }} />
            <span className="text-micro font-medium" style={{ color: 'var(--color-text-muted)' }}>
              {t('project.recent')}
            </span>
          </div>
          {recentTargets.map(p => (
            <MenuRow
              key={p.path}
              icon={<BookOpen size={12} />}
              title={p.name}
              titleHint={`${p.name}\n${p.path}`}
              swap="nav"
              onPrimary={() => openProject(p.path)}
              actions={
                /* 删除/移出：常驻 32×32（spec「操作按钮常驻」不变量，不搞 hover 才显形）；
                   位于 menu-chip 内 → hover 底色走相对叠加自动分档 */
                <button
                  type="button"
                  onClick={() => void handleDelete(p.path)}
                  className="flex items-center justify-center rounded hover:bg-[var(--color-hover)] cursor-pointer flex-shrink-0"
                  style={{ width: 32, height: 32, color: 'var(--color-text-muted)' }}
                  title={t('project.deleteTooltip')}
                >
                  <Trash2 size={12} />
                </button>
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}
