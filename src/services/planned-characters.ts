import { createToolIpc } from './agent/tool-ipc'
import type { ToolExecutionContext } from './agent/tool-registry'
import { matchCharacterName, stripNameAlias } from './character-normalize'
import { mergeCardRows } from './character-card-merge'
import { globalEventBus } from '../shared/event-bus'
import { useProjectStore } from '../stores/project-store'
import type { CharacterData } from '../../electron/repositories/character-repository'

export async function createMissingCharacters(cards: Array<Record<string, unknown>>, projectId: string, context?: ToolExecutionContext): Promise<number> {
  const toolIpc = createToolIpc(context)
  const projectPath = useProjectStore.getState().currentProject?.path
  const assertActive = () => {
    if (context?.signal.aborted || useProjectStore.getState().currentProject?.id !== projectId || useProjectStore.getState().currentProject?.path !== projectPath || (context?.scope && context.scope !== projectPath)) throw new Error('Operation cancelled or project changed')
  }
  assertActive()
  const existing = await toolIpc.invoke('db:character-get-all')
  assertActive()
  const known: Array<{ name: unknown; aliases?: unknown }> = [...existing]
  const candidates: Array<Record<string, unknown>> = []
  for (const card of cards) {
    const name = stripNameAlias(String(card.name ?? ''))
    if (!name || matchCharacterName(known, String(card.name ?? ''))) continue
    candidates.push({ ...card, name })
    known.push({ name, aliases: card.aliases })
  }
  if (candidates.length === 0) return 0
  const { rows } = mergeCardRows([], candidates)
  assertActive()
  const result = await toolIpc.invoke('db:character-create-missing', rows as unknown as CharacterData[])
  if (!result.success) throw new Error(result.error || 'Character creation failed')
  if (result.created > 0 && !context?.signal.aborted && useProjectStore.getState().currentProject?.id === projectId && useProjectStore.getState().currentProject?.path === projectPath) {
    try { globalEventBus.emit('REFRESH_RESOURCE', { resources: ['characterCards'] }) }
    catch (error) { console.warn('[characters] 已提交，角色界面刷新失败', error) }
  }
  return result.created
}
