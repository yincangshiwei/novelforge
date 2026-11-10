import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyReviewEdits, getCurrentDraftReview, isReviewCurrent, locateReviewEdits, reviewContentHash } from './review-actions'

const mock = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./ipc-client', () => ({ ipc: { invoke: mock.invoke } }))
const issue = (quote?: string) => ({ category: '文风', severity: 'warning' as const, quote, description: '去掉重复修饰' })
beforeEach(() => mock.invoke.mockReset())

describe('安全报告修稿', () => {
  it('唯一引用局部替换，其余全文逐字不变', () => {
    const content = '前文\n\n需要修改\n\n后文'
    const spans = locateReviewEdits(content, [issue('需要修改')])
    expect(applyReviewEdits(content, spans.map(s => ({ ...s, replacement: '改好了' })))).toBe('前文\n\n改好了\n\n后文')
  })
  it('拒绝缺引用、不存在、重复和重叠引用', () => {
    expect(() => locateReviewEdits('正文', [issue()])).toThrow()
    expect(() => locateReviewEdits('正文', [issue('不存在')])).toThrow()
    expect(() => locateReviewEdits('重复重复', [issue('重复')])).toThrow()
    expect(() => locateReviewEdits('abcdef', [issue('abc'), issue('bcde')])).toThrow()
  })
  it('报告必须属于当前版本且指纹一致，旧报告不自动信任', async () => {
    const baseContentHash = await reviewContentHash('正文')
    const report = JSON.stringify({ baseDraftId: 3, baseContentHash })
    expect(await isReviewCurrent(report, 3, '正文')).toBe(true)
    expect(await isReviewCurrent(report, 4, '正文')).toBe(false)
    expect(await isReviewCurrent(report, 3, '新正文')).toBe(false)
    expect(await isReviewCurrent('{}', 3, '正文')).toBe(false)
  })
  it('仅选择当前草稿有效报告且不把通过条目当修改要求', async () => {
    const content = JSON.stringify({ baseDraftId: 3, baseContentHash: await reviewContentHash('正文'), items: [issue('正文'), { ...issue(), severity: 'pass' }] })
    mock.invoke.mockImplementation(async (channel: string) => channel === 'db:review-list' ? [{ id: 8, reviewIndex: 1 }] : { content })
    const report = await getCurrentDraftReview(3, '正文', 'p1')
    expect(JSON.parse(report!).items).toHaveLength(1)
    expect(JSON.parse(report!).reviewSourceId).toBe(8)
  })
})
