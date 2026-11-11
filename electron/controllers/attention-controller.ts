import { BrowserWindow, Notification, type WebContents } from 'electron'
import { guardedHandle } from '../security/ipc-guard'
import { GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, readJsonFile } from '../utils/config-utils'
import { resolveAttentionPrefs, validAttentionRequest, type AttentionRequest } from '../../src/shared/attention-prefs'
import type { GlobalConfig } from '../../src/shared/ipc-channels'
import { t } from '../../src/shared/locale'

interface PendingNotice { request: AttentionRequest; notification?: Notification; alerted: boolean }
const windows = new Map<number, { window: BrowserWindow; pending: Map<string, PendingNotice>; dispose: () => void; alert: () => void }>()

function ensureWindow(sender: WebContents) {
  const existing = windows.get(sender.id)
  if (existing) return existing
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed()) return undefined
  const pending = new Map<string, PendingNotice>()
  const alert = () => {
    if (window.isDestroyed() || window.isFocused() && window.isVisible() && !window.isMinimized()) return
    for (const notice of pending.values()) {
      if (notice.alerted) continue
      notice.alerted = true
      window.flashFrame(true)
      try {
        if (!Notification.isSupported()) continue
        const prefs = resolveAttentionPrefs(readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG))
        const notification = new Notification({ title: t('attention.title'),
          body: t(notice.request.kind === 'approval' ? 'attention.approval' : 'attention.workflow'),
          silent: !prefs.soundEnabled,
        })
        notice.notification = notification
        notification.on('click', () => {
          if (!pending.has(notice.request.id) || window.isDestroyed() || sender.isDestroyed()) return
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
          window.flashFrame(false)
          sender.send('attention:activate', { id: notice.request.id })
        })
        notification.show()
      } catch (error) { console.warn('[Attention]', error) }
    }
  }
  const focus = () => { if (!window.isDestroyed()) window.flashFrame(false) }
  const clear = () => {
    for (const notice of pending.values()) notice.notification?.close()
    pending.clear()
    focus()
  }
  const navigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) clear() }
  const dispose = () => {
    clear()
    window.removeListener('blur', alert)
    window.removeListener('minimize', alert)
    window.removeListener('hide', alert)
    window.removeListener('focus', focus)
    sender.removeListener('did-start-navigation', navigation)
    sender.removeListener('render-process-gone', clear)
    windows.delete(sender.id)
  }
  window.on('blur', alert)
  window.on('minimize', alert)
  window.on('hide', alert)
  window.on('focus', focus)
  window.once('closed', dispose)
  sender.on('did-start-navigation', navigation)
  sender.on('render-process-gone', clear)
  const state = { window, pending, dispose, alert }
  windows.set(sender.id, state)
  return state
}

export function registerAttentionController() {
  guardedHandle('attention:register', (event, request: unknown) => {
    if (!validAttentionRequest(request)) return { success: false }
    const state = ensureWindow(event.sender)
    if (!state || state.pending.size >= 100) return { success: false }
    if (state.pending.has(request.id)) return { success: true }
    state.pending.set(request.id, { request: { ...request }, alerted: false })
    state.alert()
    return { success: true }
  })
  guardedHandle('attention:clear', (event, id: unknown) => {
    if (typeof id !== 'string') return { success: false }
    const state = windows.get(event.sender.id)
    const notice = state?.pending.get(id)
    notice?.notification?.close()
    state?.pending.delete(id)
    if (state && !state.pending.size && !state.window.isDestroyed()) state.window.flashFrame(false)
    return { success: true }
  })
}
