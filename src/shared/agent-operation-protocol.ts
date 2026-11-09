export interface AgentOperationRequest {
  operationId: string
  callId: string
  turnId: string
  conversationId?: string
  scope?: string
  toolName: string
  channel: string
  args: unknown[]
}

export interface AgentOperationResult {
  state: 'committed' | 'not_committed' | 'unknown'
  value?: unknown
  error?: string
}

export interface AgentOperationRecord {
  operationId: string
  callId: string
  turnId: string
  conversationId?: string
  scope: string
  toolName: string
  channel: string
  state: 'running' | 'committed' | 'not_committed' | 'unknown'
  updatedAt: number
  target?: string
  error?: string
}
