export interface ArchiveSaveState {
  status: 'pending' | 'saved' | 'failed'
  version: number
  savedVersion: number
  error?: string
}

export class ArchiveQueue {
  private tails = new Map<string, Promise<boolean>>()
  private snapshots = new Map<string, string>()
  private deleted = new Set<string>()
  private deletions = new Map<string, () => Promise<{ success: boolean }>>()
  readonly states = new Map<string, ArchiveSaveState>()
  constructor(
    private write: (id: string, snapshot: string) => Promise<{ success: boolean }>,
    private changed: (id: string, state: ArchiveSaveState) => void,
  ) {}

  save(id: string, snapshot: string): Promise<boolean> {
    if (this.deleted.has(id)) return Promise.resolve(false)
    this.snapshots.set(id, snapshot)
    const old = this.states.get(id)
    const version = (old?.version ?? 0) + 1
    this.set(id, { status: 'pending', version, savedVersion: old?.savedVersion ?? 0 })
    const work = (this.tails.get(id) ?? Promise.resolve(true)).then(async () => {
      try {
        const result = await this.write(id, snapshot)
        if (!result.success) throw new Error('会话归档写盘失败')
        const current = this.states.get(id)!
        this.set(id, { ...current, savedVersion: version, status: current.version === version ? 'saved' : 'pending', error: undefined })
        return true
      } catch (error) {
        const current = this.states.get(id)!
        this.set(id, { ...current, status: current.version === version ? 'failed' : 'pending', error: String(error) })
        return false
      }
    })
    this.tails.set(id, work)
    void work.then(() => { if (this.tails.get(id) === work) this.tails.delete(id) })
    return work
  }

  remove(id: string, erase: () => Promise<{ success: boolean }>): Promise<boolean> {
    this.deleted.add(id)
    this.deletions.set(id, erase)
    const state = this.states.get(id)
    const version = (state?.version ?? 0) + 1
    this.set(id, { status: 'pending', version, savedVersion: state?.savedVersion ?? 0 })
    const work = (this.tails.get(id) ?? Promise.resolve(true)).then(async () => {
      try {
        if (!(await erase()).success) throw new Error('归档删除失败')
        this.set(id, { status: 'saved', version, savedVersion: version })
        this.snapshots.delete(id)
        this.deletions.delete(id)
        return true
      } catch (error) {
        this.set(id, { status: 'failed', version, savedVersion: state?.savedVersion ?? 0, error: String(error) })
        return false
      }
    })
    this.tails.set(id, work)
    void work.then(() => { if (this.tails.get(id) === work) this.tails.delete(id) })
    return work
  }

  async flush(): Promise<boolean> {
    while (this.tails.size) await Promise.all([...this.tails.values()])
    const retry = [...this.states].filter(([, state]) => state.status === 'failed')
    await Promise.all(retry.map(([id]) => this.deletions.has(id)
      ? this.remove(id, this.deletions.get(id)!) : this.save(id, this.snapshots.get(id)!)))
    while (this.tails.size) await Promise.all([...this.tails.values()])
    return [...this.states.values()].every(state => state.status === 'saved')
  }

  private set(id: string, state: ArchiveSaveState): void {
    this.states.set(id, state)
    this.changed(id, state)
  }
}
