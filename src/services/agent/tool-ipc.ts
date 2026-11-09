import { ipc } from '../ipc-client'
import type { AllInvokeChannels, InvokeChannel } from '../../shared/ipc-channels'
import type { ToolExecutionContext } from './tool-registry'
import { waitWithAbort } from './abort-wait'
import { ToolExecutionInterrupted } from './tool-execution'

const sequences = new WeakMap<ToolExecutionContext, number>()

export function createToolIpc(context?: ToolExecutionContext): Pick<typeof ipc, 'invoke'> {
  if (!context) return ipc
  return {
    invoke: async <C extends InvokeChannel>(channel: C, ...args: AllInvokeChannels[C]['args']): Promise<AllInvokeChannels[C]['return']> => {
      if (context.signal.aborted) throw new ToolExecutionInterrupted('操作已取消，未启动', false)
      const sequence = sequences.get(context) ?? 0
      sequences.set(context, sequence + 1)
      const operationId = `${context.operationId}:ipc:${sequence}`
      const cancel = (): void => { void ipc.invoke('agent:operation-cancel', context.callId).catch(() => {}) }
      context.signal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await waitWithAbort(ipc.invoke('agent:operation-invoke', {
          operationId, callId: context.callId, turnId: context.turnId, scope: context.scope, conversationId: context.conversationId,
          toolName: context.toolName ?? '', channel, args,
        }), context.signal)
        if (result.state === 'unknown') throw new ToolExecutionInterrupted(result.error ?? '执行状态未知，需查询操作记录', true)
        if (result.state === 'not_committed' && result.value === undefined) throw new ToolExecutionInterrupted(result.error ?? '操作未提交', false)
        if (result.value && typeof result.value === 'object' && (result.value as { responseUnavailable?: boolean }).responseUnavailable) {
          throw new ToolExecutionInterrupted('操作已提交，但原外部响应未持久化；禁止重复调用以获取响应', true)
        }
        return result.value as AllInvokeChannels[C]['return']
      } catch (error) {
        cancel()
        throw error
      } finally { context.signal.removeEventListener('abort', cancel) }
    },
  }
}
