// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentExecutionSection from './AgentExecutionSection'
import { t } from '../../shared/locale'

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
let invoke: ReturnType<typeof vi.fn>
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    void args
    if (channel === 'config:get') return { agentExecution: { maxTaskSteps: 240 } }
    if (channel === 'config:set') return { success: true }
    return null
  })
  Object.defineProperty(window, 'velaAPI', { value: { invoke }, configurable: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })
async function render() {
  act(() => { root.render(<AgentExecutionSection />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
async function save() {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === t('action.save'))!
  expect(button.disabled).toBe(false)
  await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
}

describe('Agent 执行设置', () => {
  it('加载已有预算并说明连续执行及共享计数', async () => {
    await render()
    expect(container.querySelector('input')?.value).toBe('240')
    expect(container.textContent).toContain(t('settings.agentExecutionDesc'))
    expect(container.textContent).toContain('共享计数')
  })

  it('保存只写独立配置键，超范围输入先归一化', async () => {
    await render()
    const input = container.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '999999')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await save()
    expect(invoke.mock.calls.find(call => call[0] === 'config:set')?.[1]).toEqual({ agentExecution: { maxTaskSteps: 1000 }, attention: { approvalTimeoutMinutes: 10, soundEnabled: true } })
    expect(input.value).toBe('1000')
  })

  it('批准等待可设不限，声音可关闭且和预算一起保存', async () => {
    await render()
    const select = container.querySelector('select')!
    expect(select.value).toBe('10')
    act(() => {
      select.value = '0'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click()
    })
    await save()
    expect(invoke.mock.calls.find(call => call[0] === 'config:set')?.[1]).toEqual({
      agentExecution: { maxTaskSteps: 240 }, attention: { approvalTimeoutMinutes: 0, soundEnabled: false },
    })
  })

  it('旧配置回默认100，读失败明确提示而非冒充成功读取', async () => {
    invoke.mockRejectedValue(new Error('unavailable'))
    await render()
    expect(container.querySelector('input')?.value).toBe('100')
    expect(container.textContent).toContain(t('settings.compactionLoadFailed'))
  })
})
