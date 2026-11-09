import type { AgentTool, ToolExecutionContext, ToolResult } from './tool-registry'
import { executionTarget } from './execution-evidence'
import type { ToolCallInfo } from './agent-engine'
import { waitWithAbort } from './abort-wait'
import { canonicalJson } from '../../shared/canonical-json'

export class ToolExecutionInterrupted extends Error {
  constructor(message: string, readonly unknown: boolean) { super(message) }
}

const unresolved = new Map<string, { context: ToolExecutionContext; args: string; result?: ToolResult }>()

export function restoreUnknownExecutions(calls: readonly ToolCallInfo[], scope: string, conversationId?: string): void {
  for (const call of calls) {
    if (call.receipt?.outcome !== 'unknown') continue
    const key = `${scope}:${call.toolName}:${call.receipt.target}`
    if (!unresolved.has(key)) unresolved.set(key, {
      args: canonicalJson(call.arguments),
      context: { signal: new AbortController().signal, turnId: call.turnId ?? '', step: call.step ?? 0,
        callId: call.id, operationId: call.id, scope, toolName: call.toolName, conversationId },
    })
  }
}

export async function executeTool(
  tool: AgentTool, args: Record<string, unknown>, context: ToolExecutionContext, timeoutMs: number,
): Promise<ToolResult> {
  if (context.signal.aborted) throw new ToolExecutionInterrupted('操作已取消，未启动', false)
  const key = `${context.scope ?? context.turnId}:${tool.name}:${executionTarget(tool.name, args)}`
  const previous = unresolved.get(key)
  if (!tool.isReadOnly && previous) {
    const checking = new AbortController()
    const abortCheck = (): void => checking.abort()
    context.signal.addEventListener('abort', abortCheck, { once: true })
    const checkTimer = setTimeout(abortCheck, timeoutMs)
    let actual: ToolResult | undefined
    try {
      actual = previous.result ?? (tool.reconcile ? await waitWithAbort(
        tool.reconcile(JSON.parse(previous.args), {
          ...previous.context, signal: checking.signal, toolName: tool.name,
          callId: crypto.randomUUID(), operationId: crypto.randomUUID(),
        }), checking.signal,
      ) : undefined)
    } catch {
      throw new ToolExecutionInterrupted('写入核对已中断或超时，执行状态仍未知，禁止重试', true)
    } finally {
      clearTimeout(checkTimer)
      context.signal.removeEventListener('abort', abortCheck)
    }
    if (!actual || actual.executionState === 'unknown' || (!actual.success && actual.executionState !== 'not_committed')) {
      throw new ToolExecutionInterrupted('先前写入状态未知，已阻止重复写入；必须核对实际状态后再处理', true)
    }
    unresolved.delete(key)
    if (actual.success && previous.args === canonicalJson(args)) return { ...actual, content: `先前操作 ${previous.context.operationId} 已提交，未重复执行。\n${actual.content}` }
  }
  if (context.signal.aborted) throw new ToolExecutionInterrupted('操作已取消，未启动', false)
  const controller = new AbortController()
  const entry: { context: ToolExecutionContext; args: string; result?: ToolResult } = { context, args: canonicalJson(args) }
  let timer: ReturnType<typeof setTimeout> | undefined
  let interrupted = false
  let started = false
  let rejectInterrupt: (error: Error) => void = () => {}
  const interrupt = (message: string): void => {
    interrupted = true
    const unknown = started && !tool.isReadOnly
    if (unknown) unresolved.set(key, entry)
    rejectInterrupt(new ToolExecutionInterrupted(started ? message : '操作已中断，未启动', unknown))
    controller.abort()
  }
  const abort = (): void => interrupt('操作已取消；已经启动的写入可能已提交，执行状态待核对')
  try {
    const stop = new Promise<never>((_, reject) => { rejectInterrupt = reject })
    context.signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => interrupt(`工具执行超时（${timeoutMs / 1000} 秒）；写入状态待核对，不得盲重试`), timeoutMs)
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted || context.signal.aborted) throw new ToolExecutionInterrupted('操作已取消，未启动', false)
      started = true
      return tool.execute(args, { ...context, signal: controller.signal })
    }).then(result => {
      if (interrupted) entry.result = result
      if (!tool.isReadOnly && result.executionState === 'unknown') unresolved.set(key, { ...entry, result: undefined })
      return result
    }, error => {
      if (!tool.isReadOnly && !(error instanceof ToolExecutionInterrupted && !error.unknown)) unresolved.set(key, entry)
      throw error
    })
    return await Promise.race([work, stop])
  } finally {
    if (timer) clearTimeout(timer)
    context.signal.removeEventListener('abort', abort)
  }
}
