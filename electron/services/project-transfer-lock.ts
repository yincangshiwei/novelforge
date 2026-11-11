let locked = false
let activeCalls = 0

export function isProjectTransferLocked(): boolean { return locked }
export function enterProjectCall(): () => void {
  if (locked) throw new Error('Project transfer in progress')
  activeCalls++
  return () => { activeCalls-- }
}
export async function withProjectTransferLock<T>(work: () => Promise<T>): Promise<T> {
  if (locked || activeCalls > 1) throw new Error('Project is busy; wait for other operations to finish')
  locked = true
  try { return await work() } finally { locked = false }
}
