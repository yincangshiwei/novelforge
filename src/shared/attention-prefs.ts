export interface AttentionPrefs {
  approvalTimeoutMinutes: 2 | 10 | 30 | 0
  soundEnabled: boolean
}

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = { approvalTimeoutMinutes: 10, soundEnabled: true }

export function resolveAttentionPrefs(config?: { attention?: unknown } | null): AttentionPrefs {
  const raw = config?.attention
  const values = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const minutes = values.approvalTimeoutMinutes
  return {
    approvalTimeoutMinutes: minutes === 0 || minutes === 2 || minutes === 10 || minutes === 30
      ? minutes : DEFAULT_ATTENTION_PREFS.approvalTimeoutMinutes,
    soundEnabled: typeof values.soundEnabled === 'boolean' ? values.soundEnabled : DEFAULT_ATTENTION_PREFS.soundEnabled,
  }
}

export function approvalTimeoutMs(prefs: AttentionPrefs): number | null {
  return prefs.approvalTimeoutMinutes === 0 ? null : prefs.approvalTimeoutMinutes * 60_000
}

export interface AttentionRequest {
  id: string
  kind: 'approval' | 'workflow'
}

export function validAttentionRequest(value: unknown): value is AttentionRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  return typeof request.id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(request.id)
    && (request.kind === 'approval' || request.kind === 'workflow')
}
