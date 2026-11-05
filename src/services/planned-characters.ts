import { ipc } from './ipc-client'
import { matchCharacterName, stripNameAlias } from './character-normalize'
import { mergeCardRows } from './character-card-merge'
import { globalEventBus } from '../shared/event-bus'
import { useProjectStore } from '../stores/project-store'
import type { CharacterData } from '../../electron/repositories/character-repository'

export async function createMissingCharacters(cards: Array<Record<string, unknown>>, projectId: string): Promise<number> {
  if (useProjectStore.getState().currentProject?.id !== projectId) throw new Error('Project changed')
  const existing = await ipc.invoke('db:character-get-all')
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
  if (useProjectStore.getState().currentProject?.id !== projectId) throw new Error('Project changed')
  const result = await ipc.invoke('db:character-create-missing', rows as unknown as CharacterData[])
  if (!result.success) throw new Error(result.error || 'Character creation failed')
  if (result.created > 0 && useProjectStore.getState().currentProject?.id === projectId) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources: ['characterCards'] })
  }
  return result.created
}
