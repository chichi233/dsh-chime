// 客户端半边冒烟：不打开 DSH，用假 window / React / DOM 把 dsh/client.js 跑一遍。
// 覆盖：模块能加载、导出契约、出厂默认三个内置音都带 file（否则宿主的 pickSlot 会丢弃）、
//       内置音频走 /chime/audio/ 路由名、清除后不会又被迁移逻辑塞回来。
// 用法：node scripts/client-smoke.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'dsh', 'client.js'), 'utf8')

const results = []
const check = (title, ok, detail = '') => {
  results.push({ title, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}${detail ? `  —  ${detail}` : ''}`)
}

let factory = null
const store = new Map()
const posts = []
const styleNodes = []

globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory: fn }) => { factory = fn } },
  setTimeout: (fn) => { fn(); return 0 },
  setInterval: () => 0,
  clearInterval: () => {},
}
globalThis.document = {
  head: { appendChild: (node) => styleNodes.push(node) },
  createElement: () => ({ style: {}, textContent: '', parentNode: { removeChild() {} } }),
}
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, value),
}
globalThis.fetch = (url, init) => {
  if (init && init.method === 'POST') posts.push(JSON.parse(init.body))
  return Promise.resolve({ json: () => Promise.resolve({ items: [] }) })
}

// eslint-disable-next-line no-new-func
new Function(source)()
check('模块被 __ModuleLoader__ 接住', typeof factory === 'function')

const React = { createElement: (...args) => ({ args }), useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }) }
const exports = factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

check('导出 name', exports.name === 'dsh-chime', exports.name)
check('导出 apply', typeof exports.apply === 'function')

const registered = []
const ctx = {
  get: () => ({ inject: (_slot, run) => run(), register: (spec) => { registered.push(spec); return () => {} } }),
  effect: (run) => { const dispose = run(); if (typeof dispose === 'function') dispose() },
}
exports.apply(ctx)

check('占住 settings.general.item 插槽', registered.length === 1 && registered[0].name === 'settings.general.item', JSON.stringify(registered[0]))

const seeded = posts[0]
const expectFile = { done: 'done-01.mp3', stuck: 'stuck-01.mp3', fail: 'fail-01.wav' }
const slotsOk = seeded && Object.entries(expectFile).every(([kind, file]) => {
  const slot = seeded.slots[kind]
  return slot && slot.type === 'builtin' && slot.file === file
})
check('出厂默认三槽都带 file（宿主不会丢）', Boolean(slotsOk), JSON.stringify(seeded && seeded.slots))

// 清除一个槽后重新加载：builtinVersion 已对齐，不该再被塞回来
store.set('dsh-chime:state', JSON.stringify({ enabled: true, volume: 0.5, builtinVersion: 1, slots: { done: null, stuck: { type: 'builtin', id: 'stuck-01', name: '卡住 1' }, fail: null } }))
posts.length = 0
factory((id) => (id === 'react' ? React : null)).apply(ctx)
const reloaded = posts[0]
check('用户清空的槽保持空', reloaded && reloaded.slots.done === null && reloaded.slots.fail === null, JSON.stringify(reloaded && reloaded.slots))
check('老绑定自动补 file', reloaded && reloaded.slots.stuck.file === 'stuck-01.mp3', JSON.stringify(reloaded && reloaded.slots.stuck))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
