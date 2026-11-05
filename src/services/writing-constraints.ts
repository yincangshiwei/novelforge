import { useProjectStore } from '../stores/project-store'
import { ipc } from './ipc-client'
import { parseAliases } from './character-normalize'

export async function readWritingConstraints(options: { chapterNumber?: number; characterNames?: string[]; text?: string; includeGlobal?: boolean } = {}): Promise<string> {
  const project = useProjectStore.getState().currentProject
  if (!project) return ''
  const sections: string[] = []
  if (options.includeGlobal !== false) {
    sections.push(`【作者全局写作要求】\n${project.novelConfig.globalGuidance || ''}`)
    if (project.novelConfig.writingStyle) sections.push(`【文风】\n${project.novelConfig.writingStyle}`)
  }
  const names = new Set(options.characterNames ?? [])
  if (options.chapterNumber) {
    const bp = await ipc.invoke('db:blueprint-get', options.chapterNumber)
    bp?.characters?.forEach(name => names.add(name))
    if (bp?.userGuidance && options.includeGlobal !== false) sections.push(`【本章作者指导】\n${bp.userGuidance}`)
  }
  const cards = await ipc.invoke('db:character-get-all')
  const selected = cards.filter(card => [card.name, ...parseAliases(card.aliases)].some(name => names.has(name) || (name && options.text?.includes(name))))
  if (selected.length) sections.push(`【本次相关角色最新静态档案：优先于旧图谱；未来计划不可当作已发生事实】\n${JSON.stringify(selected.map(card => ({
    name: card.name, role: card.role, tier: card.tier, appearance: card.appearance,
    personality: card.personality, background: card.background, abilities: card.abilities,
    motivation: card.motivation, relationships: card.relationships, arc: card.arc, notes: card.notes,
  })))}`)
  if (useProjectStore.getState().currentProject?.id !== project.id) throw new Error('Project changed')
  return sections.join('\n\n')
}
