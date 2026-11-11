import { describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(async (channel: string, payload: unknown) => { void channel; void payload; return { success: true } }), callback: undefined as undefined | ((data: { id: string }) => void), unsubscribe: vi.fn() }))
vi.mock('./ipc-client', () => ({ ipc: {
  invoke: mock.invoke,
  on: (_channel: string, callback: (data: { id: string }) => void) => { mock.callback = callback; return mock.unsubscribe },
} }))
import { registerUserAttention, subscribeUserAttention } from './user-attention'

describe('人工等待提醒生命周期', () => {
  it('登记仅含类型和ID不泄露参数，点击只调用定位，结束后晚到点击无效', async () => {
    const activate = vi.fn()
    const unsubscribe = subscribeUserAttention()
    const clear = registerUserAttention('approval', activate)
    const request = mock.invoke.mock.calls[0][1] as { id: string; kind: string }
    expect(Object.keys(request).sort()).toEqual(['id', 'kind'])
    mock.callback?.({ id: request.id })
    expect(activate).toHaveBeenCalledOnce()
    clear(); clear()
    mock.callback?.({ id: request.id })
    expect(activate).toHaveBeenCalledOnce()
    expect(mock.invoke).toHaveBeenCalledTimes(2)
    expect(mock.invoke).toHaveBeenLastCalledWith('attention:clear', request.id)
    unsubscribe()
    expect(mock.unsubscribe).toHaveBeenCalledOnce()
  })
})
