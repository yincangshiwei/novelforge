const active = new Set<string>()
const starts = new Map<string, Promise<unknown>>()
const cancellations = new Map<string, Promise<void>>()
const failed = new Set<string>()

export function registerLLMRequest(id: string): void {
  active.add(id)
}

export function finishLLMRequest(id: string): void {
  active.delete(id)
}

export function trackLLMStart<T>(id: string, work: Promise<T>): Promise<T> {
  starts.set(id, work)
  void work.then(() => { if (starts.get(id) === work) starts.delete(id) }, () => {
    if (starts.get(id) === work) starts.delete(id)
  })
  return work
}

export function cancelTrackedLLMRequest(id: string, cancel: (id: string) => Promise<void>): Promise<void> {
  const existing = cancellations.get(id)
  if (existing) return existing
  const work = Promise.resolve().then(() => cancel(id))
  cancellations.set(id, work)
  void work.then(() => {
    failed.delete(id)
    if (cancellations.get(id) === work) cancellations.delete(id)
  }, () => {
    failed.add(id)
    if (cancellations.get(id) === work) cancellations.delete(id)
  })
  return work
}

export async function drainLLMRequests(cancel: (id: string) => Promise<void>): Promise<void> {
  const ids = new Set([...active, ...starts.keys(), ...cancellations.keys(), ...failed])
  const starting = [...starts.values()]
  await Promise.all([...ids].map(id => cancelTrackedLLMRequest(id, cancel)))
  await Promise.allSettled(starting)
  await Promise.all([...ids].map(id => cancelTrackedLLMRequest(id, cancel)))
  for (const id of ids) active.delete(id)
}
