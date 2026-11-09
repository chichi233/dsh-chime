// dsh-chime 冒烟测试：不启动 DSH，用假的 ctx 把宿主半边跑一遍。
// 覆盖：三类事件的队列产物、失败对完成音的抑制、状态读写、内置音路由与路径穿越拦截、两只工具。
// 用法：node scripts/smoke.mjs
import { apply, name, inject } from '../dsh/index.js'

const routes = new Map()
const tools = new Map()
const listeners = new Map()

const ctx = {
  on(event, handler) {
    const list = listeners.get(event) ?? []
    list.push(handler)
    listeners.set(event, list)
  },
  inject(deps, run) {
    run({
      webServer: {
        register(route) {
          const key = `${route.kind}:${route.path}`
          // 真宿主这里会抛 webserver: duplicate prefix route —— 残留路由就是靠这个暴露的
          if (routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
          routes.set(key, route)
          return () => routes.delete(key)
        },
      },
    })
  },
  effect(run) {
    run()
  },
  tools: {
    register(spec) {
      tools.set(spec.name, spec)
    },
  },
}

// 模拟禁用/启用循环留下的僵尸 prefix 路由：占住 /chime/audio/，逼插件退到备用基址
routes.set('prefix:/chime/audio', { kind: 'prefix', path: '/chime/audio', handler: async (_req, res) => { res.writeHead(404).end() } })

apply(ctx)

const emit = (event, payload) => {
  for (const handler of listeners.get(event) ?? []) {
    if (event === 'approval/request' || event === 'tools/pre-execute') handler(payload, () => {})
    else handler(payload)
  }
}
const agent = (id) => ({ id })

const resolve = (kind, path) => {
  if (kind === 'exact') return routes.get(`exact:${path}`)
  for (const route of routes.values()) {
    // 与 dsh-host-webserver lib/index.js:500 同语义：前缀必须落在 '/' 边界上
    if (route.kind === 'prefix' && (path === route.path || path.startsWith(`${route.path}/`))) return route
  }
  return undefined
}
const call = async (kind, path, method = 'GET', body) => {
  const route = resolve(kind, path)
  if (!route) throw new Error(`route missing: ${kind}:${path}`)
  const out = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
  const res = {
    writeHead(status, headers = {}) {
      out.status = status
      out.headers = headers
      return this
    },
    end(chunk) {
      if (chunk) out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    },
  }
  await route.handler(req, res)
  return out
}
const drain = async () => JSON.parse((await call('exact', '/chime/drain')).body.toString('utf8')).items

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  —  ' + detail : ''}`)
}

// 契约
check('导出契约', name === 'dsh-chime' && inject.includes('tools'), `name=${name} inject=${JSON.stringify(inject)}`)

// 完成：running → idle
emit('agent/status', { agent: agent('a1'), status: 'running' })
emit('agent/status', { agent: agent('a1'), status: 'idle' })
let items = await drain()
check('完成事件入队', items.length === 1 && items[0].kind === 'done', JSON.stringify(items))

// 卡住：审批 + 提问，去重只留一条
emit('approval/request', { toolName: 'ops_bash' })
emit('tools/pre-execute', { name: 'ask_user_question' })
items = await drain()
check('卡住事件入队并去重', items.length === 1 && items[0].kind === 'stuck', JSON.stringify(items))

// 失败 + 随后的 idle：只响失败，不补完成
emit('agent/status', { agent: agent('a2'), status: 'running' })
emit('agent/error', { agent: agent('a2'), turn: 2, step: 5 })
emit('agent/status', { agent: agent('a2'), status: 'idle' })
items = await drain()
check('失败优先（不再补完成音）', items.length === 1 && items[0].kind === 'fail', JSON.stringify(items))

// 出厂默认：三个内置音各自绑定（还没被面板上报覆盖时）
const fresh = await tools.get('chime_status').execute()
check('出厂默认三槽都有内置音', fresh.done.startsWith('内置') && fresh.stuck.startsWith('内置') && fresh.fail.startsWith('内置'), JSON.stringify(fresh))

// 状态：POST → GET 往返，槽位能存能清
const post = await call('exact', '/chime/state', 'POST', JSON.stringify({
  enabled: false,
  volume: 0.35,
  slots: { done: { type: 'imported', name: '我的铃声.mp3' }, stuck: null, fail: null },
}))
check('状态写入', post.status === 200 && JSON.parse(post.body.toString('utf8')).ok === true)
const state = JSON.parse((await call('exact', '/chime/state')).body.toString('utf8'))
check('状态读回', state.enabled === false && state.volume === 0.35 && state.slots.done.name === '我的铃声.mp3' && state.slots.stuck === null, JSON.stringify(state))

// 非法槽位被拒
await call('exact', '/chime/state', 'POST', JSON.stringify({ slots: { fail: { type: 'builtin', file: '../../etc/passwd' } } }))
const guarded = JSON.parse((await call('exact', '/chime/state')).body.toString('utf8'))
check('内置音文件名白名单', guarded.slots.fail === null, JSON.stringify(guarded.slots.fail))

// 内置音文件路由：基址应从 /chime/state 的 audioBase 拿到（这里是回退后的备用基址）
const stateBody = JSON.parse((await call('exact', '/chime/state')).body.toString('utf8'))
check('僵尸 prefix 路由存在时会退到备用基址', stateBody.audioBase !== '/chime/audio/', stateBody.audioBase)
const audio = await call('prefix', `${stateBody.audioBase}stuck-01.mp3`)
check('内置音可取', audio.status === 200 && audio.headers['content-type'] === 'audio/mpeg' && audio.body.length > 1000, `${audio.status} ${audio.headers['content-type']} ${audio.body.length}B`)
const failAudio = await call('prefix', `${stateBody.audioBase}fail-01.wav`)
check('失败内置音可取', failAudio.status === 200 && failAudio.headers['content-type'] === 'audio/wav' && failAudio.body.length > 50000, `${failAudio.status} ${failAudio.headers['content-type']} ${failAudio.body.length}B`)
const traversal = await call('prefix', `${stateBody.audioBase}..%2F..%2Fpackage.json`)
check('路径穿越被挡', traversal.status === 404, String(traversal.status))

// 工具
const status = await tools.get('chime_status').execute()
check('chime_status 读到槽位', status.done.includes('导入') && status.fail === '未设置', JSON.stringify(status))
const played = await tools.get('chime_play').execute({ kind: 'done' })
check('chime_play 按槽位判断会不会响', played.queued === 'done' && played.bound === true, JSON.stringify(played))
await drain()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
