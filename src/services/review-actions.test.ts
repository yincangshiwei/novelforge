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
  it('缺引用、不存在和无位置的重复引用分别说明具体原因', () => {
    expect(() => locateReviewEdits('正文', [issue()])).toThrow('没有可定位引用')
    expect(() => locateReviewEdits('正文', [issue('不存在')])).toThrow('与正文不匹配')
    expect(() => locateReviewEdits('重复重复', [issue('重复')])).toThrow('出现多次')
  })
  it('重叠及相同范围自动合并，保留全部修复要求和范围外正文', () => {
    const spans = locateReviewEdits('前abcdef后', [issue('abc'), issue('bcde'), issue('abc')])
    expect(spans).toHaveLength(1)
    expect(spans[0].quote).toBe('abcde')
    expect(spans[0].issues).toHaveLength(3)
    expect(applyReviewEdits('前abcdef后', [{ ...spans[0], replacement: '修复' }])).toBe('前修复f后')
  })
  it('程序位置标记可区分重复引用，但必须验证引用内容', () => {
    const content = '重复重复'
    expect(locateReviewEdits(content, [{ ...issue('重复'), quoteStart: '2', quoteEnd: '4' }])[0].start).toBe(2)
    expect(() => locateReviewEdits(content, [{ ...issue('重复'), quoteStart: '1', quoteEnd: '3' }])).toThrow('出现多次')
  })
  it.each(['甲\n乙', '**甲<br>乙**', '甲\\n乙'])('恢复换行及外层格式 %j，仍只替换原文范围', quote => {
    const content = '前甲\r\n\r\n  \r\n乙后'
    const span = locateReviewEdits(content, [issue(quote)])[0]
    expect(span.quote).toBe('甲\r\n\r\n  \r\n乙')
    expect(applyReviewEdits(content, [{ ...span, replacement: '修改' }])).toBe('前修改后')
  })
  it('不把改写、省略或格式恢复后的重复引用猜成唯一位置', () => {
    expect(() => locateReviewEdits('甲乙丙', [issue('甲…丙')])).toThrow('与正文不匹配')
    expect(() => locateReviewEdits('甲\n\n乙，甲\r\n乙', [issue('甲<br>乙')])).toThrow('出现多次')
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
