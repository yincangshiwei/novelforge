export type AgentTimelineBlock =
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'tools'; callIds: string[] }
