import { expect, it, vi } from 'vitest'
import { RefineFromReviewCommand } from './refine-from-review.command'
import { reviewContentHash } from '../../review-actions'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn() }))
vi.mock('../../ipc-client', () => ({ ipc: { invoke: mocks.invoke } }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: { id: 'p1', novelConfig: {} } }) } }))
vi.mock('../../writing-constraints', () => ({ readWritingConstraints: async () => '' }))
vi.mock('../chapter-workflow', () => ({ parseDraftMeta: async () => ({ id: 1, version: 2, status: 'draft' }) }))
vi.mock('../../audit/refinement-audit', () => ({ auditRefinement: async () => ({ summary: '完成' }), openRefinementAudit: vi.fn() }))
vi.mock('../../../stores/editor-store', () => ({ useEditorStore: { getState: () => ({ openFile: vi.fn() }) } }))
class LocalCommand extends RefineFromReviewCommand {
  protected async callLLM(request: string) {
    mocks.request(request)
    return '修改后片段'
  }
}

it.each([false, true])('仅改选中引用，重叠=%s 时合并要求，不直接覆盖底稿', async overlap => {
  vi.clearAllMocks()
  const draft = '前文。原始片段。后文。'
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'db:draft-get-full') return { content: draft }
    if (channel === 'db:revision-get-pending') return []
    if (channel === 'db:revision-next-index') return 1
    return { success: true, id: 8 }
  })
  const items = [{ category: '文风', severity: 'warning', quote: '原始片段', description: '改一下' }]
  if (overlap) items.push({ category: '剧情', severity: 'warning', quote: '始片', description: '改善衔接' })
  const report = JSON.stringify({ baseDraftId: 1, baseContentHash: await reviewContentHash(draft), items })
  const command = new LocalCommand({ draftPath: 'vela://draft/1', draftContent: draft, chapterNumber: 1, reviewReport: report, localOnly: true })
  expect(await command.execute({ step: {}, context: { data: {}, cancelled: false }, callbacks: { log: vi.fn(), appendText: vi.fn(), setProgress: vi.fn() } })).toBe('前文。修改后片段。后文。')
  expect(mocks.request).toHaveBeenCalledOnce()
  const request = JSON.parse(mocks.request.mock.calls[0][0].trim())
  expect(request.excerpt).toBe('原始片段')
  expect(request.issues).toHaveLength(overlap ? 2 : 1)
  expect(mocks.invoke.mock.calls.some(call => call[0] === 'db:draft-update-content')).toBe(false)
  const saved = mocks.invoke.mock.calls.find(call => call[0] === 'db:revision-create')
  expect(saved![1].content).toBe('前文。修改后片段。后文。')
})
