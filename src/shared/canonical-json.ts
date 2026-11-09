export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (typeof input !== 'object' || input === null) throw new TypeError('操作参数必须是严格 JSON，不能包含未定义值或非有限数')
    if (ancestors.has(input)) throw new TypeError('操作参数不能包含循环引用')
    const prototype = Object.getPrototypeOf(input)
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('操作参数只能包含普通对象和数组')
    }
    if (Object.getOwnPropertySymbols(input).length > 0) throw new TypeError('操作参数不能包含 Symbol 键')
    ancestors.add(input)
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) throw new TypeError('操作参数不能包含稀疏数组或数组扩展属性')
        return Array.from({ length: input.length }, (_, index) => {
          if (!Object.prototype.hasOwnProperty.call(input, index)) throw new TypeError('操作参数不能包含稀疏数组')
          const descriptor = Object.getOwnPropertyDescriptor(input, index)!
          if (!('value' in descriptor)) throw new TypeError('操作参数不能包含访问器属性')
          return normalize(descriptor.value)
        })
      }
      return Object.fromEntries(Object.keys(input).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor)) throw new TypeError('操作参数不能包含访问器属性')
        return [key, normalize(descriptor.value)]
      }))
    } finally {
      ancestors.delete(input)
    }
  }
  return JSON.stringify(normalize(value))
}
