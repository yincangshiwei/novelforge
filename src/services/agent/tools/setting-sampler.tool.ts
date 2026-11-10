/**
 * setting_sampler — 冷门设定采样工具
 *
 * 对抗"创意撞车"：从知识库中采样低相关度（冷门）片段，
 * 作为可选参考喂给 LLM，提示在合适契机化用、避免套路。
 * 判定标准：用随机低频词检索，取相关度最低的尾部结果。
 */
import { buildAgentTool } from '../tool-registry'
import { t } from '../../../shared/locale'
import { createToolIpc } from '../tool-ipc'
import type { ToolExecutionContext } from '../tool-registry'
import { useProjectStore } from '../../../stores/project-store'

/** 按流派分桶的低频检索词池（与常见网文高频套路词拉开距离，同时避免跨流派串味） */
const GENRE_COLD_QUERY_POOLS: Record<string, string[]> = {
  '玄幻': ['古籍残页', '锈蚀机关', '边疆驿道', '老匠人', '废弃祭坛', '石窟壁画', '铜铃', '荒原界碑'],
  '仙侠': ['古籍残页', '丹炉余烬', '边疆驿道', '旧剑穗', '废弃祭坛', '石窟壁画', '铜铃', '渡口孤舟'],
  '都市': ['老旧街区', '便利店夜班', '旧票据', '地下车库', '天台水箱', '报刊亭', '末班地铁', '旧收音机'],
  '科幻': ['废弃轨道站', '旧型号芯片', '冷却管道', '加密日志', '边缘殖民地', '休眠舱', '频段杂音', '旧时代遗物'],
  '悬疑': ['旧案卷宗', '褪色照片', '停摆挂钟', '走廊尽头', '匿名信件', '潮湿地下室', '不在场记录', '钥匙孔'],
  '历史': ['边关烽燧', '地方县志', '旧漕船', '驿站马牌', '祠堂碑文', '铁匠铺', '铜钱锈迹', '城门告示'],
}

const DEFAULT_COLD_QUERY_POOL = [
  '角落旧物', '边缘人物', '日常器物', '破损信件', '地方风物',
  '旧规矩', '偏僻场所', '微小习惯', '往事细节', '特殊禁忌',
]

function pickColdQuery(genre?: string): string {
  const g = (genre || '').trim()
  const matchedKey = Object.keys(GENRE_COLD_QUERY_POOLS).find(k => g.includes(k))
  const pool = matchedKey ? GENRE_COLD_QUERY_POOLS[matchedKey] : DEFAULT_COLD_QUERY_POOL
  return pool[Math.floor(Math.random() * pool.length)]
}

/**
 * 从知识库采样冷门设定片段（低相关度尾部）
 * @param count 采样条数
 */
export async function sampleColdSettings(count = 2, context?: ToolExecutionContext): Promise<string> {
  const toolIpc = createToolIpc(context)
  const project = useProjectStore.getState().currentProject
  if (!project) return ''

  try {
    // 按本书流派选择低频词检索，取尾部（低相关度）结果
    const query = pickColdQuery(project.novelConfig?.genre)
    const results = (await toolIpc.invoke('kb:search', query, 8)) as Array<{
      text: string; fileName: string; score: number
    }> | null

    if (!results || results.length === 0) return ''

    // 按相关度升序取尾部（最不相关 = 最冷门），最多 count 条
    const cold = [...results].sort((a, b) => a.score - b.score).slice(0, Math.min(count, results.length))
    if (cold.length === 0) return ''

    return cold.map((r, i) => t('tool.samplerItem')
      .replace('{index}', String(i + 1))
      .replace('{name}', r.fileName)
      .replace('{score}', (r.score * 100).toFixed(0))
      .replace('{text}', r.text.slice(0, 300))).join('\n\n')
  } catch {
    return ''
  }
}

export const settingSamplerTool = buildAgentTool({
  name: 'setting_sampler',
  description: t('tool.samplerDesc'),
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: t('tool.samplerCount'),
        default: 2,
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args, context) => {
    if (context?.signal.aborted) return { success: false, executionState: 'not_committed', content: '', error: '操作已取消' }
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: t('error.noProject') }
    }
    const count = Math.min(Math.max(Number(args.count ?? 2), 1), 3)
    const sampled = await sampleColdSettings(count, context)
    if (!sampled) {
      return { success: true, content: t('tool.samplerEmpty') }
    }
    return {
      success: true,
      content: t('tool.samplerResult').replace('{sampled}', sampled),
    }
  },
})
