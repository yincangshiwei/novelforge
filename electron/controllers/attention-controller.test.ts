import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockWindow extends EventEmitter {
  isDestroyed: () => boolean
  isFocused: () => boolean
  isVisible: () => boolean
  isMinimized: () => boolean
  flashFrame: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}
interface MockNotice extends EventEmitter {
  options: { silent: boolean }
  close: ReturnType<typeof vi.fn>
}
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(),
  window: null as MockWindow | null, notices: [] as MockNotice[], config: {} as unknown, supported: true }))
vi.mock('../security/ipc-guard', () => ({ guardedHandle: (name: string, handler: (...args: unknown[]) => unknown) => mock.handlers.set(name, handler) }))
vi.mock('../utils/config-utils', () => ({ GLOBAL_CONFIG_PATH: 'config', DEFAULT_GLOBAL_CONFIG: {}, readJsonFile: () => mock.config }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    BrowserWindow: { fromWebContents: () => mock.window },
    Notification: class extends EventEmitter {
      static isSupported() { return mock.supported }
      show = vi.fn()
      close = vi.fn()
      constructor(public options: { silent: boolean }) { super(); mock.notices.push(this) }
    },
  }
})
import { registerAttentionController } from './attention-controller'

let sender: EventEmitter & { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }
let window: MockWindow
beforeEach(() => {
  mock.notices.length = 0
  mock.config = {}
  mock.supported = true
  window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isFocused: () => false, isVisible: () => true, isMinimized: () => true,
    flashFrame: vi.fn(), restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
  })
  sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
  mock.window = window
  registerAttentionController()
})
afterEach(() => window.emit('closed'))
const register = (id = 'wait-1') => mock.handlers.get('attention:register')!({ sender }, { id, kind: 'approval' })
const clear = (id = 'wait-1') => mock.handlers.get('attention:clear')!({ sender }, id)

describe('后台人工等待提醒', () => {
  it('后台提醒带系统声音；点击恢复窗口但只发导航事件；相同等待去重', () => {
    expect(register()).toEqual({ success: true })
    register()
    expect(mock.notices).toHaveLength(1)
    expect(mock.notices[0].options.silent).toBe(false)
    expect(window.flashFrame).toHaveBeenCalledWith(true)
    expect(window.focus).not.toHaveBeenCalled()
    mock.notices[0].emit('click')
    expect(window.restore).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenCalledWith('attention:activate', { id: 'wait-1' })
  })
  it('前台不通知；待处理期间切到后台才提醒', () => {
    window.isFocused = () => true
    window.isMinimized = () => false
    register()
    expect(mock.notices).toHaveLength(0)
    window.isFocused = () => false
    window.emit('blur')
    expect(mock.notices).toHaveLength(1)
    window.emit('focus')
    expect(window.flashFrame).toHaveBeenLastCalledWith(false)
  })
  it('静音设置不发声；结束后旧通知点击无效', () => {
    mock.config = { attention: { approvalTimeoutMinutes: 10, soundEnabled: false } }
    register()
    const notice = mock.notices[0]
    expect(notice.options.silent).toBe(true)
    clear()
    expect(notice.close).toHaveBeenCalledOnce()
    notice.emit('click')
    expect(sender.send).not.toHaveBeenCalled()
  })
  it('通知不支持仍闪任务栏；非法请求被拒绝', () => {
    mock.supported = false
    register()
    expect(mock.notices).toHaveLength(0)
    expect(window.flashFrame).toHaveBeenCalledWith(true)
    expect(mock.handlers.get('attention:register')!({ sender }, { id: '../x', kind: 'approval' })).toEqual({ success: false })
  })
  it('渲染重载清理全部提醒，不留旧导航', () => {
    register()
    const notice = mock.notices[0]
    sender.emit('did-start-navigation', {}, 'app', false, true)
    notice.emit('click')
    expect(notice.close).toHaveBeenCalledOnce()
    expect(sender.send).not.toHaveBeenCalled()
  })
})
