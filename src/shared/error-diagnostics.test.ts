import { describe, expect, it } from 'vitest'
import { errorDetails, errorMessage, redactErrorText } from './error-diagnostics'

describe('错误诊断', () => {
  it('对象错误可读，循环对象仍能处理', () => {
    expect(errorMessage({ message: '保存失败' })).toContain('保存失败')
    expect(errorMessage({ apiKey: 'private-value' })).not.toContain('private-value')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe('[object Object]')
  })
  it('堆栈和cause保留，凭据脱敏', () => {
    const error = new Error('批次失败', { cause: new Error('Bearer secret-key api_key=private sk-abcdefgh') })
    const detail = errorDetails(error)
    expect(detail).toContain('批次失败')
    expect(detail).toContain('Caused by:')
    expect(detail).not.toContain('secret-key')
    expect(detail).not.toContain('private')
    expect(detail).not.toContain('sk-abcdefgh')
  })
  it('循环cause与过长诊断受限', () => {
    const error = new Error('失败')
    error.cause = error
    expect(errorDetails(error).split('Caused by:')).toHaveLength(1)
    expect(redactErrorText('x'.repeat(20000))).toHaveLength(12000)
  })
})
