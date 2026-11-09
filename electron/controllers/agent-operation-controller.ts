import type { AgentOperationRequest } from '../../src/shared/agent-operation-protocol'
import { IPC_CHANNEL_POLICY } from '../../src/shared/ipc-policy'
import type { InvokeChannel } from '../../src/shared/ipc-channels'
import { dispatchAgentOperationIpc, guardedHandle, isAgentOperationChannelAllowed } from '../security/ipc-guard'
import { getAgentOperationJournal } from '../services/agent-operation-journal'
import { getCurrentProjectPath } from '../database'
import path from 'node:path'

export function registerAgentOperationController(): void {
  guardedHandle('agent:operation-invoke', async (event, request: AgentOperationRequest) => {
    if (!request || !isAgentOperationChannelAllowed(request.channel) || !Array.isArray(request.args) || (request.scope !== undefined && typeof request.scope !== 'string')) {
      return { state: 'not_committed' as const, error: '不允许的工具IPC请求' }
    }
    const authority = IPC_CHANNEL_POLICY[request.channel as InvokeChannel].authority
    if ((authority === 'read-project' || authority === 'write-project') &&
      (!request.scope || !getCurrentProjectPath() || path.resolve(request.scope) !== path.resolve(getCurrentProjectPath()!))) {
      return { state: 'not_committed' as const, error: '操作项目与当前项目不匹配' }
    }
    return getAgentOperationJournal().invoke(request, event.sender.id,
      () => dispatchAgentOperationIpc(event, request.channel, request.args),
      !['fs:write-file', 'db:draft-apply-content', 'db:character-upsert', 'db:character-create-missing', 'project:update-config', 'kb:import-text', 'dev:invoke', 'mcp:call-tool'].includes(request.channel),
    )
  })
  guardedHandle('agent:operation-cancel', async (event, callId: string) => {
    if (typeof callId !== 'string' || !callId) return { success: false }
    getAgentOperationJournal().cancel(callId, event.sender.id)
    return { success: true }
  })
  guardedHandle('agent:operation-list', async (_event, scope: string) => {
    if (typeof scope !== 'string') return []
    return getAgentOperationJournal().list(scope)
  })
}
