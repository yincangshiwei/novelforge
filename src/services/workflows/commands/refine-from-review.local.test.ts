import { expect, it, vi } from 'vitest'
import { RefineFromReviewCommand } from './refine-from-review.command'
import { reviewContentHash } from '../../review-actions'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invoke: mocks.invoke } }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: { id: 'p1', novelConfig: {} } }) } }))
vi.mock('../../writing-constraints', () => ({ readWritingConstraints: async () => '' }))
vi.mock('../chapter-workflow', () => ({ parseDraftMeta: async () => ({ id: 1, version: 2, status: 'draft' }) }))
vi.mock('../../audit/refinement-audit', () => ({ auditRefinement: async () => ({ summary: '完成' }), openRefinementAudit: vi.fn() }))
vi.mock('../../../stores/editor-store', () => ({ useEditorStore: { getState: () => ({ openFile: vi.fn() }) } }))
class LocalCommand extends RefineFromReviewCommand {
  protected async callLLM() { return '修改后片段' }
}

it('仅改选中引用并创建候选，不直接覆盖底稿', async () => {
  const draft = '前文。原始片段。后文。'
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'db:draft-get-full') return { content: draft }
    if (channel === 'db:revision-get-pending') return []
    if (channel === 'db:revision-next-index') return 1
    return { success: true, id: 8 }
  })
  const report = JSON.stringify({ baseDraftId: 1, baseContentHash: await reviewContentHash(draft), items: [{ category: '文风', severity: 'warning', quote: '原始片段', description: '改一下' }] })
  const command = new LocalCommand({ draftPath: 'vela://draft/1', draftContent: draft, chapterNumber: 1, reviewReport: report, localOnly: true })
  expect(await command.execute({ step: {}, context: { data: {}, cancelled: false }, callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() } })).toBe('前文。修改后片段。后文。')
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'db:draft-update-content')).toBe(false)
  const saved = mocks.invoke.mock.calls.find(call => call[0] === 'db:revision-create')
  expect(saved![1].content).toBe('前文。修改后片段。后文。')
})
