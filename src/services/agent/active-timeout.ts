export class ActiveTimeout {
  private timer?: ReturnType<typeof setTimeout>
  private startedAt: number
  private remainingMs: number
  private pauses = 0
  private disposed = false

  constructor(private readonly durationMs: number, private readonly expire: () => void,
    private readonly now: () => number = Date.now) {
    this.remainingMs = durationMs
    this.startedAt = now()
    this.arm()
  }

  private arm(): void {
    if (this.disposed || this.pauses) return
    this.startedAt = this.now()
    this.timer = setTimeout(() => {
      this.remainingMs = 0
      this.disposed = true
      this.expire()
    }, Math.max(0, this.remainingMs))
  }

  get elapsedMs(): number {
    const remaining = this.remainingMs - (this.pauses || this.disposed ? 0 : Math.max(0, this.now() - this.startedAt))
    return this.durationMs - remaining
  }

  pause(): () => void {
    if (this.disposed) return () => {}
    if (this.pauses++ === 0) {
      this.remainingMs -= Math.max(0, this.now() - this.startedAt)
      clearTimeout(this.timer)
    }
    let released = false
    return () => {
      if (released || this.disposed) return
      released = true
      if (--this.pauses === 0) this.arm()
    }
  }

  dispose(): void {
    if (this.disposed) return
    if (!this.pauses) this.remainingMs -= Math.max(0, this.now() - this.startedAt)
    this.disposed = true
    clearTimeout(this.timer)
  }
}
