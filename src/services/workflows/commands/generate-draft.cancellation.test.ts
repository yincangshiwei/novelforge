// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { GenerateDraftCommand } from './generate-draft.command'
import type { ChapterInfo } from '../chapter-workflow'
import { ipc } from '../../ipc-client'

vi.mock('../../ipc-client', () => ({ ipc: { invoke: vi.fn() } }))
vi.mock('../../../stores/project-store', () => ({ useProjectStore: { getState: vi.fn() } }))
vi.mock('../../render-logger', () => ({ renderLog: vi.fn() }))

describe('generate-draft cancellation', () => {
  it.each(['signal', 'legacy'])('pre-cancelled %s does not start reads or writes', async kind => {
    const controller = new AbortController()
    if (kind === 'signal') controller.abort()
    const callbacks = { log: vi.fn(), setProgress: vi.fn(), appendText: vi.fn() }
    const command = new GenerateDraftCommand({ chapterNumber: 1, title: 'title' } as ChapterInfo)
    await expect(command.execute({
      step: {}, context: { data: {}, cancelled: kind === 'legacy', signal: controller.signal }, callbacks,
    })).rejects.toThrow()
    expect(ipc.invoke).not.toHaveBeenCalled()
    expect(callbacks.log).not.toHaveBeenCalled()
  })
})
