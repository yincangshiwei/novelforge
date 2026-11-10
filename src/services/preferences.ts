/**
 * preferences — 偏好记忆（渲染层服务）
 *
 * 检测"用户把 AI 文本的 X 改成 Y"：AI 预览接受后用户手动修改，
 * 通过前后缀匹配提取替换对，记录到 preferences 表；写稿前检索注入。
 */
import { ipc } from './ipc-client'
import type { PreferenceData } from '../../electron/repositories/preference-repository'

/** 用户将 AI 冗余短语直接删空时的哨兵值（复用 preferences 表，无需额外迁移表结构） */
export const DELETED_PREF_SENTINEL = '__DELETED__'

/** 记录一个替换对（防抖由调用方控制） */
export async function recordPreference(aiText: string, userText: string): Promise<void> {
  try {
    await ipc.invoke('db:preference-record', aiText, userText)
  } catch { /* 记录失败不阻塞编辑 */ }
}

/** 获取 Top 偏好（供写稿注入） */
export async function getTopPreferences(limit = 5): Promise<PreferenceData[]> {
  try {
    return await ipc.invoke('db:preference-get-top', limit)
  } catch {
    return []
  }
}

/**
 * 从 AI 原文与用户改后文本中提取替换对或删减偏好。
 * 算法：前缀/后缀匹配 → 中间差异段；
 * 1. 替换模式：差异段为 2-20 字中文短语（允许含常见句内标点，捕获节奏微调与词组平替）
 * 2. 删减模式：用户将 AI 的 2-12 字修饰词/套话直接删空（userDiff 为空）→ 记录为 DELETED_PREF_SENTINEL 厌恶表达
 */
export function extractPreferencePair(
  aiText: string,
  userText: string,
): { ai: string; user: string } | null {
  if (!aiText || !userText || aiText === userText) return null

  // 前缀匹配
  const maxLen = Math.min(aiText.length, userText.length)
  let prefix = 0
  while (prefix < maxLen && aiText[prefix] === userText[prefix]) prefix++
  // 后缀匹配（从前缀之后开始，避免重复计算）
  let suffix = 0
  while (
    suffix < maxLen - prefix &&
    aiText[aiText.length - 1 - suffix] === userText[userText.length - 1 - suffix]
  ) {
    suffix++
  }

  const aiDiff = aiText.slice(prefix, aiText.length - suffix)
  const userDiff = userText.slice(prefix, userText.length - suffix)

  // 模式 B：用户直接删掉 AI 的冗余套话短语（如删掉“不由自主地”“在这一刻”）
  const trimmedAiDeleted = aiDiff.replace(/^[，、\s]+|[，、\s]+$/g, '')
  if (!userDiff.trim() && isValidDiff(trimmedAiDeleted)) {
    return { ai: trimmedAiDeleted, user: DELETED_PREF_SENTINEL }
  }

  if (!isValidDiff(aiDiff) || !isValidDiff(userDiff)) return null
  return { ai: aiDiff, user: userDiff }
}

/** 差异段有效判定：2-12 字纯中文（无标点/空白/字母，排除句子级增删与整段重写） */
function isValidDiff(diff: string): boolean {
  const len = diff.length
  if (len < 2 || len > 12) return false
  return /^[一-龥]+$/.test(diff)
}
