import { ipc } from './ipc-client'
import type { AttentionRequest } from '../shared/attention-prefs'

type PendingAttention = AttentionRequest & { activate: () => void | Promise<void> }
const pending = new Map<string, PendingAttention>()

export function registerUserAttention(kind: AttentionRequest['kind'], activate: PendingAttention['activate']): () => void {
  const id = crypto.randomUUID()
  pending.set(id, { id, kind, activate })
  void ipc.invoke('attention:register', { id, kind }).catch(error => console.warn('[Attention]', error))
  return () => {
    if (!pending.delete(id)) return
    void ipc.invoke('attention:clear', id).catch(error => console.warn('[Attention]', error))
  }
}

export function subscribeUserAttention(): () => void {
  return ipc.on('attention:activate', ({ id }) => {
    const item = pending.get(id)
    if (item) void Promise.resolve(item.activate()).catch(error => console.warn('[Attention]', error))
  })
}
