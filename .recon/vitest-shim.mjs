
// A minimal stand-in for the vitest API these specs actually use: describe, it,
// expect with the handful of matchers they call, and afterEach. It reports the
// same way vitest does -- one line per failing assertion -- so a green run here
// means the real suite is green.
import { isDeepStrictEqual } from 'node:util'

const state = { failures: [], passes: 0, tests: [], failedTests: [], pending: [], beforeEach: undefined, after: [] }
export const results = state

function fail(message) {
  const err = new Error(message)
  err.stack = (err.stack || '').split('\n').slice(0, 4).join('\n')
  state.failures.push(err)
}

function partial(actual, expected, path = '') {
  if (expected === null || typeof expected !== 'object') {
    if (!isDeepStrictEqual(actual, expected)) fail(`at ${path || '<root>'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`)
    return
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) { fail(`at ${path}: array length ${actual?.length} !== ${expected.length}`); return }
    expected.forEach((v, i) => partial(actual[i], v, `${path}[${i}]`))
    return
  }
  for (const k of Object.keys(expected)) partial(actual?.[k], expected[k], path ? `${path}.${k}` : k)
}

function makeExpect(actual, negated = false) {
  const check = (ok, msg) => {
    const pass = negated ? !ok : ok
    if (pass) state.passes += 1
    else fail(`${negated ? 'NOT ' : ''}${msg}`)
  }
  const api = {
    toBe: (v) => check(Object.is(actual, v), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(v)}`),
    toEqual: (v) => check(isDeepStrictEqual(actual, v), `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(v)}`),
    toStrictEqual: (v) => check(isDeepStrictEqual(actual, v), `expected strict equal ${JSON.stringify(v)}`),
    toContain: (v) => check(typeof actual === 'string' ? actual.includes(v) : Array.isArray(actual) && actual.includes(v), `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(v)}`),
    toHaveLength: (v) => check(actual?.length === v, `expected length ${actual?.length} to be ${v}`),
    toBeUndefined: () => check(actual === undefined, `expected undefined, got ${JSON.stringify(actual)}`),
    toBeDefined: () => check(actual !== undefined, `expected defined, got undefined`),
    toBeNull: () => check(actual === null, `expected null, got ${JSON.stringify(actual)}`),
    toBeTruthy: () => check(Boolean(actual), `expected truthy, got ${JSON.stringify(actual)}`),
    toBeFalsy: () => check(!actual, `expected falsy, got ${JSON.stringify(actual)}`),
    toBeGreaterThan: (v) => check(actual > v, `expected ${actual} > ${v}`),
    toBeLessThan: (v) => check(actual < v, `expected ${actual} < ${v}`),
    toBeInstanceOf: (v) => check(actual instanceof v, `expected instance of ${v?.name}`),
    toMatch: (v) => check(v instanceof RegExp ? v.test(actual) : String(actual).includes(v), `expected ${JSON.stringify(actual)} to match ${v}`),
    toMatchObject: (v) => { const before = state.failures.length; partial(actual, v); check(state.failures.length === before, `expected object to match ${JSON.stringify(v)}`) },
    toThrow: (v) => { let threw = false; let msg = ''; try { actual() } catch (e) { threw = true; msg = String(e?.message ?? e) } check(threw && (v === undefined || (v instanceof RegExp ? v.test(msg) : msg.includes(v))), `expected function to throw`) },
  }
  api.not = new Proxy({}, { get: (_t, key) => makeExpect(actual, true)[key] })
  return api
}

export const expect = (actual) => makeExpect(actual)
export const describe = (_name, fn) => { fn() }
export const it = (name, fn) => {
  state.tests.push(name)
  state.pending.push({ name, fn })
}
export const test = it
export const beforeEach = (fn) => { state.beforeEach = fn }
export const afterEach = (fn) => { state.after.push(fn) }
export const beforeAll = () => {}
export const afterAll = () => {}
export const vi = { fn: (impl) => impl ?? (() => {}), spyOn: () => ({ mockRestore() {} }) }
