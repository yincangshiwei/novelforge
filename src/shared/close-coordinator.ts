let closing = false
let attempt: Promise<boolean> | null = null

export function isCloseCoordinating(): boolean {
  return closing
}

export function coordinateClose(drains: Array<() => Promise<boolean>>): Promise<boolean> {
  if (attempt) return attempt
  closing = true
  attempt = Promise.resolve().then(async () => {
    const results = await Promise.allSettled(drains.map(drain => Promise.resolve().then(drain)))
    return results.every(result => result.status === 'fulfilled' && result.value === true)
  }).then(saved => {
    if (!saved) closing = false
    attempt = null
    return saved
  }, () => {
    closing = false
    attempt = null
    return false
  })
  return attempt
}
