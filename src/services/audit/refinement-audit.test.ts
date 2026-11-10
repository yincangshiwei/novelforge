import { describe, expect, it, vi } from 'vitest'
import { auditRefinement, openRefinementAudit } from './refinement-audit'
import { useEditorStore } from '../../stores/editor-store'

vi.mock('./audit-context', () => ({ loadAuditWhitelist: async () => undefined }))

describe('修稿候选专项复查', () => {
  it('审计候选正文并绑定底稿，不修改正文', async () => {
    const text = '他知道，这一切才刚刚开始。'
    const result = await auditRefinement(text, 7, 2)
    expect(result).toMatchObject({ checked: true, scope: 'revision_candidate', baseDraftId: 7, baseVersion: 2 })
    expect(result.items.some(i => i.severity === 'error')).toBe(true)
    expect(text).toBe('他知道，这一切才刚刚开始。')
  })
  it('空正文不标记通过', async () => {
    expect(await auditRefinement('')).toMatchObject({ checked: false })
  })
  it('打开候选报告不携带原稿修稿入口', () => {
    useEditorStore.getState().clearTabs()
    openRefinementAudit('{}', 8, 1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ id: 'revision-audit-8', reportPath: 'vela://revision/8/audit' })
    expect(useEditorStore.getState().tabs[0].filePath).toBeUndefined()
  })
})
