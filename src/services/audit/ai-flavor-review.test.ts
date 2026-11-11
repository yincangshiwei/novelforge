import { describe, expect, it } from 'vitest'
import { aiFlavorAudit } from './audits'
import { mergeAiFlavorReview } from './ai-flavor-review'
import { parseReport } from '../../components/editor/review-report-parser'
import { locateReviewEdits } from '../review-actions'

const draft = '他走进屋子。\n\n他知道，这一切才刚刚开始。'

describe('专项报告合并', () => {
  it.each(['table', 'json', 'raw'])('%s输出都展示专项结果且保留原模型内容', format => {
    const parsed = format === 'raw'
      ? { items: [], rawResponse: '模型返回了无法解析的意见。' }
      : { items: [{ category: '剧情', severity: 'pass', description: '没有矛盾' }], summary: '审查完成' }
    const report = mergeAiFlavorReview(parsed, aiFlavorAudit(draft), draft)
    const visible = parseReport(JSON.stringify(report))
    expect(visible.parseFailed).toBe(false)
    expect(visible.issues.some(i => i.quote === '他知道，这一切才刚刚开始。' && i.severity === 'error')).toBe(true)
    if (format === 'raw') {
      expect(visible.issues.some(i => i.description.includes('无法解析'))).toBe(true)
      expect(report.rawResponse).toBe(parsed.rawResponse)
    }
  })
  it.each(['\n\n', '\r\n\r\n', '\n\n\n', '\n  \n'])('多段引用保留原文分隔 %j 及中间段，可以安全定位', separator => {
    const text = `  仿佛犹如一阵风。${separator}  他走进屋子。${separator}  宛如仿佛一片云。  `
    const report = mergeAiFlavorReview({ items: [] }, aiFlavorAudit(text), text)
    const issue = parseReport(JSON.stringify(report)).issues.find(i => i.quote?.includes('一阵风'))!
    expect(issue.quote).toBe(text.trim())
    const spans = locateReviewEdits(text, [issue])
    expect(spans).toHaveLength(1)
    expect(text.slice(spans[0].start, spans[0].end)).toBe(issue.quote)
  })
  it('重复段落使用审计的准确位置，不猜选首次匹配', () => {
    const text = '重复段落。\n\n重复段落。'
    const report = mergeAiFlavorReview({ items: [] }, { passed: false, summary: '', issues: [{ kind: 'repetition', severity: 'warn', position: '第2段', message: '重复' }] }, text)
    const spans = locateReviewEdits(text, parseReport(JSON.stringify(report)).issues)
    expect(spans[0].start).toBe(text.lastIndexOf('重复段落。'))
  })
  it('对话复读报告包含所有命中段落的真实引用，可以直接修复', () => {
    const text = '“我们一定能走出去的。”\n\n他站了起来。\n\n“我们一定能走出去的。”\n\n“我们一定能走出去的。”'
    const report = mergeAiFlavorReview({ items: [] }, aiFlavorAudit(text), text)
    const issue = parseReport(JSON.stringify(report)).issues.find(i => i.description.includes('我们一定能走出去的'))!
    expect(issue.quote).toBe(text)
    expect(locateReviewEdits(text, [issue])).toHaveLength(1)
  })
  it('模型引用的换行格式在报告保存前恢复为真实原文并附位置', () => {
    const text = '甲\r\n\r\n乙'
    const report = mergeAiFlavorReview({ items: [{ category: '剧情', severity: 'warning', quote: '甲<br>乙', description: '衔接' }] }, { passed: false, summary: '', issues: [] }, text)
    expect(report.items[0].quote).toBe(text)
    expect(report.items[0].quoteStart).toBe('0')
  })
  it('warn映射warning且通过报告说明规则覆盖边界', () => {
    const report = mergeAiFlavorReview({ items: [] }, { passed: false, summary: '发现重复', issues: [{ kind: 'repetition', severity: 'warn', message: '重复' }] }, draft)
    expect(report.items[0].severity).toBe('warning')
    const passed = mergeAiFlavorReview({ items: [] }, aiFlavorAudit('他走进屋子。'), draft)
    expect(passed.items[0].severity).toBe('pass')
    expect(passed.items[0].description).toContain('不代表')
  })
})
