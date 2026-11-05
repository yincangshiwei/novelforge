import { useProjectStore } from '../../stores/project-store'
import { BaseWorkflowCommand, type CommandExecuteParams } from './commands/base-command'
import type { StepCallbacks, WorkflowContext } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'
import { getPromptTemplate } from '../prompt-templates'
import { ArchitecturePromptBuilder } from '../prompts/prompt-builder'
import { assembleCharacterCards, extractCharactersFromText } from './architecture-workflow'
import { stripThinkingTags, stringifyField } from './workflow-utils'
import { createMissingCharacters } from '../planned-characters'
import type { ChapterBlueprint } from './directory-workflow'

class PlannedCharacterCommand extends BaseWorkflowCommand<string> {
  constructor(private prompt: string, private systemRole: string) { super() }
  execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    return this.callLLM(this.prompt, this.systemRole, callbacks, { purpose: 'character_extract' }, context)
  }
}

export async function extractPlannedCharacters(blueprints: ChapterBlueprint[], projectId: string, callbacks: StepCallbacks, context: WorkflowContext): Promise<void> {
  const project = useProjectStore.getState().currentProject
  if (!project || project.id !== projectId || blueprints.length === 0) return
  const existing = await ipc.invoke('db:character-get-all')
  const { matchCharacterName } = await import('../character-normalize')
  const hasUnknown = blueprints.some(bp => bp.characters.some(name => !matchCharacterName(existing, name)))
  if (!hasUnknown) return
  const template = getPromptTemplate('extract_planned_characters')
  if (!template) throw new Error('Missing template: extract_planned_characters')
  let created = 0
  for (let offset = 0; offset < blueprints.length; offset += 20) {
    if (useProjectStore.getState().currentProject?.id !== projectId) throw new Error('Project changed')
    const batch = blueprints.slice(offset, offset + 20)
    const prompt = new ArchitecturePromptBuilder(template)
      .withCharacterDynamics(JSON.stringify({ existingNames: existing.map(c => ({ name: c.name, aliases: c.aliases })), blueprints: batch }))
      .withGenre(project.novelConfig.genre)
      .build()
    if (context.cancelled) throw new Error('Workflow cancelled')
    if (!batch.some(bp => bp.characters.some(name => !matchCharacterName(existing, name)))) continue
    const content = await new PlannedCharacterCommand(prompt, template.systemRole || 'You extract character plans faithfully.')
      .execute({ step: {}, callbacks, context })
    if (context.cancelled) throw new Error('Workflow cancelled')
    const parsed = extractCharactersFromText(stripThinkingTags(content))
    const allowedNames = new Set(batch.flatMap(bp => bp.characters))
    const valid = parsed.filter(card => allowedNames.has(String(card.name ?? '')) && String(card.notes ?? '').trim())
    const cards = assembleCharacterCards(valid, stringifyField)
    for (const card of cards) delete card.currentState
    created += await createMissingCharacters(cards, projectId)
  }
  callbacks.log(`规划角色建档完成：新增 ${created} 人；已有角色档案与等级保持不变。`)
}
