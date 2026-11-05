// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest'
import { readWritingConstraints } from './writing-constraints'
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
vi.mock('./ipc-client', () => ({ ipc: { invoke: vi.fn() } }))
beforeEach(() => {
  useProjectStore.setState({ currentProject: { id: 'test', novelConfig: { globalGuidance: '统一人物服饰风格', writingStyle: '简洁' } } as never })
  vi.mocked(ipc.invoke).mockImplementation(async (...args) => {
    const channel = args[0]
    if (channel === 'db:blueprint-get') return { characters: ['林晓'], userGuidance: '突出本章的犹豫' } as never
    return [{ name: '林晓', appearance: '青衣', aliases: '["小林"]', notes: '计划第五章离开' }, { name: '未出场', appearance: '不相关内容' }] as never
  })
})
it('重写上下文包含全局、本章要求和最新人物档案，不混入无关人物', async () => {
  const result = await readWritingConstraints({ chapterNumber: 1 })
  expect(result).toContain('统一人物服饰风格')
  expect(result).toContain('突出本章的犹豫')
  expect(result).toContain('青衣')
  expect(result).toContain('未来计划不可当作已发生事实')
  expect(result).not.toContain('不相关内容')
})
it('段落改写按别名提取相关角色', async () => {
  expect(await readWritingConstraints({ text: '小林走了进来' })).toContain('青衣')
})
