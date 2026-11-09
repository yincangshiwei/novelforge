import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical-json'

describe('严格 JSON 操作指纹', () => {
  it('键顺序不影响指纹，允许重复引用但拒绝循环', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }))
    const shared = { value: 1 }
    expect(canonicalJson([shared, shared])).toBe('[{"value":1},{"value":1}]')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => canonicalJson(circular)).toThrow(TypeError)
  })

  it.each([
    undefined, NaN, Infinity, -Infinity, BigInt(1), Symbol('value'), () => 1,
    { value: undefined }, [undefined], [NaN], new Array(1), new Date(), new Map(),
    { [Symbol('key')]: 1 },
  ])('拒绝非 JSON 参数 %#', value => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })

  it('合法 null 不与无效值混淆', () => {
    expect(canonicalJson([null])).toBe('[null]')
    expect(canonicalJson(Object.assign(Object.create(null), { b: false, a: null }))).toBe('{"a":null,"b":false}')
    expect(() => canonicalJson({ get value() { return 1 } })).toThrow(TypeError)
    expect(() => canonicalJson(Object.assign([1], { extra: 2 }))).toThrow(TypeError)
  })
})
