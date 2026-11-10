/**
 * 错误处理工具 — 安全的错误消息提取
 *
 * 替换 `String(error)` 模式，避免非 Error 对象产生无意义的 "[object Object]" 消息。
 * 优先级：Error.message → string → JSON.stringify → String
 */

/** 从任意 catch 值中提取可读错误消息 */
import { errorMessage } from '../../src/shared/error-diagnostics'

export function safeErrorMessage(error: unknown): string {
  return errorMessage(error)
}
