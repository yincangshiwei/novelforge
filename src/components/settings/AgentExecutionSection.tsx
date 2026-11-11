import { useEffect, useState } from 'react'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { DEFAULT_ATTENTION_PREFS, resolveAttentionPrefs } from '../../shared/attention-prefs'
import { toast } from '../ui/Toast'
import { useTranslation } from '../../hooks/useTranslation'
import { ipc } from '../../services/ipc-client'
import { renderLog } from '../../services/render-logger'
import { DEFAULT_AGENT_EXECUTION_PREFS, MIN_TASK_STEPS, MAX_TASK_STEPS, resolveAgentExecutionPrefs } from '../../services/agent/execution-budget'

export default function AgentExecutionSection() {
  const { t } = useTranslation()
  const [steps, setSteps] = useState(DEFAULT_AGENT_EXECUTION_PREFS.maxTaskSteps)
  const [attention, setAttention] = useState(DEFAULT_ATTENTION_PREFS)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void ipc.invoke('config:get').then(config => {
      if (!cancelled) {
        setSteps(resolveAgentExecutionPrefs(config).maxTaskSteps)
        setAttention(resolveAttentionPrefs(config))
      }
    }).catch(() => {
      if (!cancelled) setLoadFailed(true)
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const prefs = resolveAgentExecutionPrefs({ agentExecution: { maxTaskSteps: steps } })
      const result = await ipc.invoke('config:set', { agentExecution: prefs, attention: resolveAttentionPrefs({ attention }) })
      if (!result?.success) throw new Error(result?.error ?? 'config:set failed')
      setSteps(prefs.maxTaskSteps)
      toast.success(t('settings.agentExecutionSaved'))
      renderLog('info', 'Save:Settings', t('settings.agentExecutionSaved'))
    } catch (error) {
      const message = t('settings.agentExecutionSaveFailed').replace('{error}', String(error))
      toast.error(message)
      renderLog('error', 'Save:Settings', message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl p-4 space-y-4" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('settings.agentExecutionTitle')}</p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>{t('settings.agentExecutionDesc')}</p>
      </div>
      {loadFailed && <p className="text-micro" style={{ color: 'var(--color-warning)' }}>{t('settings.compactionLoadFailed')}</p>}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <Label htmlFor="agent-task-budget" className="text-xs">{t('settings.agentExecutionBudget')}</Label>
          <p className="text-micro mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {t('settings.agentExecutionBudgetDesc').replace('{min}', String(MIN_TASK_STEPS)).replace('{max}', String(MAX_TASK_STEPS))}
          </p>
        </div>
        <Input id="agent-task-budget" type="number" min={MIN_TASK_STEPS} max={MAX_TASK_STEPS}
          value={Number.isFinite(steps) ? steps : ''} disabled={!loaded || saving}
          onChange={event => setSteps(event.target.value === '' ? Number.NaN : Number(event.target.value))}
          className="w-24 flex-shrink-0" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="approval-timeout">{t('settings.approvalTimeout')}</Label>
        <select id="approval-timeout" className="w-full rounded-md border p-2 text-xs"
          style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-panel)' }}
          disabled={!loaded || saving} value={attention.approvalTimeoutMinutes}
          onChange={event => setAttention(resolveAttentionPrefs({ attention: { ...attention, approvalTimeoutMinutes: Number(event.target.value) } }))}>
          {[2, 10, 30, 0].map(minutes => <option key={minutes} value={minutes}>
            {minutes === 0 ? t('settings.approvalUnlimited') : t('settings.approvalMinutes').replace('{minutes}', String(minutes))}
          </option>)}
        </select>
        <p className="text-micro" style={{ color: 'var(--color-text-muted)' }}>{t('settings.approvalTimeoutDesc')}</p>
      </div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>{t('settings.attentionSound')}</Label>
          <p className="text-micro" style={{ color: 'var(--color-text-muted)' }}>{t('settings.attentionSoundDesc')}</p>
        </div>
        <Switch aria-label={t('settings.attentionSound')} checked={attention.soundEnabled} disabled={!loaded || saving}
          onCheckedChange={soundEnabled => setAttention(value => ({ ...value, soundEnabled }))} />
      </div>
      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={!loaded || saving}>{t('action.save')}</Button>
      </div>
    </div>
  )
}
