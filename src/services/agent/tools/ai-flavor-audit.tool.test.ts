import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiFlavorAuditTool } from './ai-flavor-audit.tool'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), project: { id: 'p1' } as { id: string } | null }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: () => ({ currentProject: mocks.project }) } }))
vi.mock('../tool-ipc', () => ({ createToolIpc: () => ({ invoke: mocks.invoke }) }))
vi.mock('../../audit/audit-context', () => ({ loadAuditWhitelist: async () => undefined }))

beforeEach(() => {
  mocks.project = { id: 'p1' }
  mocks.invoke.mockReset()
  mocks.invoke.mockImplementation(async (channel: string) => channel === 'db:draft-list'
    ? [{ id: 9, version: 3, status: 'archived' }, { id: 7, version: 2, status: 'draft' }]
    : { content: '他知道，这一切才刚刚开始。' })
})

describe('ai_flavor_audit', () => {
  it('选择未归档版本，发现问题仍为成功执行且不写数据库', async () => {
    const result = await aiFlavorAuditTool.execute({ chapter_number: 1 })
    expect(result.success).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({ draftId: 7, version: 2, passed: false })
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(['db:draft-list', 'db:draft-get-full'])
  })
  it('拒绝其他章节或已归档的指定版本', async () => {
    expect((await aiFlavorAuditTool.execute({ chapter_number: 1, draft_id: 9 })).success).toBe(false)
    expect((await aiFlavorAuditTool.execute({ chapter_number: 1, draft_id: 99 })).success).toBe(false)
  })
  it('无效参数不读取正文', async () => {
    expect((await aiFlavorAuditTool.execute({ chapter_number: 1.5 })).success).toBe(false)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('项目切换后不返回旧项目检查结果', async () => {
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'db:draft-list') return [{ id: 7, version: 2, status: 'draft' }]
      mocks.project = { id: 'p2' }
      return { content: '他走进屋子。' }
    })
    expect((await aiFlavorAuditTool.execute({ chapter_number: 1 })).success).toBe(false)
  })
})
