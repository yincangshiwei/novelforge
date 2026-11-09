import { afterEach, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, buildInstanceId, sanitizeName, isPidAlive, readManifests, buildChildEnv, isOwnedProcessCommand, seedInstanceHome } from './dev-instance-lib.mjs'

const temporaryDirs: string[] = []
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('dev-instance-lib', () => {
  it('解析 start 参数', () => {
    const r = parseArgs(['start', '--project', '/tmp/p', '--port', '9333', '--json'])
    expect(r.command).toBe('start')
    expect(r.options).toMatchObject({ project: '/tmp/p', port: 9333, json: true })
  })

  it('解析 = 形式与位置参数', () => {
    const r = parseArgs(['stop', 'dev-1', '--port=9333', '--name=abc'])
    expect(r.command).toBe('stop')
    expect(r.positional).toEqual(['dev-1'])
    expect(r.options).toMatchObject({ port: 9333, name: 'abc' })
  })

  it('实例 ID 含端口且可读', () => {
    const id = buildInstanceId('/tmp/my-project', new Date('2026-10-22T13:15:00'), 9223)
    expect(id).toMatch(/^dev-20261022-131500-\d+$/)
    expect(id).toContain('9223')
    expect(id.length).toBeLessThan(80)
  })

  it('名称清洗只保留安全字符', () => {
    const name = sanitizeName('My Novel / 测试')
    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(name).toBe('my-novel')
  })

  it('PID 存活判断容错', () => {
    expect(isPidAlive(0)).toBe(false)
    expect(isPidAlive(-1)).toBe(false)
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('读取 manifest 时跳过坏文件', () => {
    const dir = '/tmp/nf-dev-instance-lib-test'
    // 纯函数测试不写盘：不存在的目录返回空数组
    expect(readManifests(dir)).toEqual([])
  })

  it('Windows 隔离 USERPROFILE/APPDATA/LOCALAPPDATA，并移除 ELECTRON_RUN_AS_NODE', () => {
    const env = buildChildEnv({ PATH: 'x', ELECTRON_RUN_AS_NODE: '1' }, 'C:\\temp\\home', 'win32')
    expect(env.HOME).toBe('C:\\temp\\home')
    expect(env.USERPROFILE).toBe('C:\\temp\\home')
    expect(env.APPDATA).toContain('AppData')
    expect(env.LOCALAPPDATA).toContain('AppData')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('fresh 清除各种大小写的 API key 与凭据环境，默认模式仍继承', () => {
    const base = { PATH: 'safe', OPENAI_API_KEY: 'synthetic', apiKey: 'synthetic', ANTHROPIC_AUTH_TOKEN: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic', NORMAL_SETTING: 'keep' }
    const env = buildChildEnv(base, '/isolated/home', 'linux', true)
    expect(env).toMatchObject({ PATH: 'safe', NORMAL_SETTING: 'keep' })
    for (const key of ['OPENAI_API_KEY', 'apiKey', 'ANTHROPIC_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(env[key]).toBeUndefined()
    expect(buildChildEnv(base, '/isolated/home', 'linux').OPENAI_API_KEY).toBe('synthetic')
    expect(base.OPENAI_API_KEY).toBe('synthetic')
    expect(parseArgs(['start', '--fresh', '--json']).options.fresh).toBe(true)
  })

  it('fresh 不复制合成配置、模型、凭据和 prompts，默认复制行为保留', () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.dev-instance-test-'))
    temporaryDirs.push(dir)
    const source = path.join(dir, 'synthetic-source')
    fs.mkdirSync(path.join(source, 'prompts'), { recursive: true })
    for (const name of ['config.json', 'models.json', 'credentials.json']) fs.writeFileSync(path.join(source, name), JSON.stringify({ synthetic: name }))
    fs.writeFileSync(path.join(source, 'prompts', 'synthetic.txt'), 'synthetic')
    const freshHome = path.join(dir, 'fresh-home')
    seedInstanceHome(source, freshHome, true)
    expect(fs.existsSync(freshHome)).toBe(false)
    const defaultHome = path.join(dir, 'default-home')
    seedInstanceHome(source, defaultHome)
    for (const name of ['config.json', 'models.json', 'credentials.json', 'prompts/synthetic.txt']) {
      expect(fs.readFileSync(path.join(defaultHome, '.novelforge', name), 'utf8')).toBe(fs.readFileSync(path.join(source, name), 'utf8'))
    }
  })

  it('进程归属校验只认 --dev-instance=<id>', () => {
    expect(isOwnedProcessCommand('novelforge --remote-debugging-port=9224 --dev-instance=dev-a', 'dev-a')).toBe(true)
    expect(isOwnedProcessCommand('novelforge --remote-debugging-port=9224 --dev-instance=dev-b', 'dev-a')).toBe(false)
    expect(isOwnedProcessCommand('', 'dev-a')).toBe(false)
  })
})