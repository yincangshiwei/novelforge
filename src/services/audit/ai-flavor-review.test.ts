import { describe, expect, it } from 'vitest'
import { aiFlavorAudit } from './audits'
import { mergeAiFlavorReview } from './ai-flavor-review'
import { parseReport } from '../../components/editor/review-report-parser'

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
  it('warn映射warning且通过报告说明规则覆盖边界', () => {
    const report = mergeAiFlavorReview({ items: [] }, { passed: false, summary: '发现重复', issues: [{ kind: 'repetition', severity: 'warn', message: '重复' }] }, draft)
    expect(report.items[0].severity).toBe('warning')
    const passed = mergeAiFlavorReview({ items: [] }, aiFlavorAudit('他走进屋子。'), draft)
    expect(passed.items[0].severity).toBe('pass')
    expect(passed.items[0].description).toContain('不代表')
  })
})
