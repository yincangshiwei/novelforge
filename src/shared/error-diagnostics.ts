export function redactErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|token|password)["']?\s*[=:]\s*["']?)[^\s"',;&]+/gi, '$1[REDACTED]')
    .slice(0, 12000)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactErrorText(error.message || error.name)
  if (typeof error === 'string') return redactErrorText(error)
  try { return redactErrorText(JSON.stringify(error) ?? String(error)) }
  catch { return redactErrorText(String(error)) }
}

export function errorDetails(error: unknown): string {
  const seen = new Set<unknown>()
  const parts: string[] = []
  let current = error
  while (current != null && !seen.has(current) && parts.length < 5) {
    seen.add(current)
    parts.push(current instanceof Error ? current.stack || errorMessage(current) : errorMessage(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return redactErrorText(parts.join('\nCaused by: '))
}
