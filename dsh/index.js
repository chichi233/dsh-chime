// dsh-chime — Host half (static bundle plugin)
//
// 零依赖 ESM：只用 node 内置模块，不 import 任何 dsh 包（与 @liustack/modlens、
// dsh-sonic 同一路数）。职责三件：
//
//   1. 听宿主事件，把三类「该响一声」的时刻压进队列：
//        - 任务完成  agent/status  running → idle
//        - 任务卡住  approval/request（等你批）/ ask_user_question（等你回话）
//        - 任务失败  agent/error（真实报错；用户按停止走 aborted，不响）
//      失败优先：刚报错的 agent 走到 idle 时不再补「完成」音。
//
//   2. 用 HTTP 路由给浏览器半边供料（webServer 服务，仅 web profile 有）：
//        GET  /chime/drain        → { items: [...] }
//        GET  /chime/state        → 面板当前选择
//        POST /chime/state        ← 面板上报
//        GET  /chime/audio/<file> → 内置音色文件（sounds/ 目录，白名单过滤）
//
//   3. 注册两个模型工具：chime_status（看状态）、chime_play（按事件试放）。
//
// 内置音色：三类事件各带一个默认音（sounds/ 下三个文件，随包发布），
// 加音色只需把音频放进 sounds/，再在 dsh/client.js 的 BUILTIN 里登记一行。
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-chime'
export const inject = ['tools']

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOUNDS_DIR = join(PKG_DIR, 'sounds')
const AUDIO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(mp3|wav|ogg|m4a|flac|aac)$/
const MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
}
/** 音频 prefix 路由的候选基址。注意：dsh-host-webserver 的 match() 用
 *  `pathname.startsWith(prefix + '/')` 判定前缀（lib/index.js:500），所以注册时不带结尾斜杠，
 *  带斜杠会拼成 `/chime/audio//`，永远匹配不上。 */
const AUDIO_BASES = ['/chime/audio', '/chime/audio-2', '/chime/audio-3']
/** 实际注册成功的基址：禁用/启用循环可能留下僵尸 prefix 路由占位，逐个退让。 */
let audioBase = AUDIO_BASES[0]

const KINDS = ['done', 'stuck', 'fail']
/** 三个内置音与 dsh/client.js 的 BUILTIN 一一对应；浏览器上报后会以浏览器那份为准。 */
const DEFAULT_STATE = {
  enabled: true,
  volume: 0.6,
  slots: {
    done: { type: 'builtin', file: 'done-01.mp3', name: '完成 1' },
    stuck: { type: 'builtin', file: 'stuck-01.mp3', name: '卡住 1' },
    fail: { type: 'builtin', file: 'fail-01.wav', name: '失败 1' },
  },
}
/** 报错后这么久内，同一 agent 的 idle 仍算失败，不补完成音。 */
const ERROR_WINDOW_MS = 5000
/** 父子代理接连完成/失败只响一声。 */
const MERGE_WINDOW_MS = 1500

const pickString = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)
const pickSlot = (value) => {
  if (!value || typeof value !== 'object') return null
  const type = value.type
  if (type === 'builtin') {
    const file = pickString(value.file)
    return file && AUDIO_FILE.test(file) ? { type: 'builtin', file, name: pickString(value.name) ?? file } : null
  }
  if (type === 'imported') return { type: 'imported', name: pickString(value.name) ?? '自定义音频' }
  return null
}
const normalizeState = (body, prev) => {
  const base = prev ?? DEFAULT_STATE
  const next = {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : base.enabled,
    volume: typeof body.volume === 'number' ? Math.min(1, Math.max(0, body.volume)) : base.volume,
    slots: { ...base.slots },
  }
  if (body.slots && typeof body.slots === 'object') {
    for (const kind of KINDS) {
      if (kind in body.slots) next.slots[kind] = pickSlot(body.slots[kind])
    }
  }
  return next
}

export function apply(ctx) {
  const pending = []
  /** 有任务正在跑的 agent id。 */
  const running = new Set()
  /** 每个 agent 最近一次报错时间，供它的 idle 转换消费。 */
  const errorAtByAgent = new Map()
  let lastDoneAt = 0
  let lastFailAt = 0
  let lastState = null

  const enqueue = (item) => {
    pending.push({ ...item, at: Date.now() })
    if (pending.length > 50) pending.shift()
  }
  const hasPending = (kind) => pending.some((item) => item.kind === kind)

  const consumeRecentError = (agentId, now) => {
    const at = errorAtByAgent.get(agentId)
    if (at === undefined) return false
    errorAtByAgent.delete(agentId)
    return now - at <= ERROR_WINDOW_MS
  }

  // —— 任务卡住：等你审批 / 等你回答，两处都要响，所以各自去重而不是共用一条
  ctx.on('approval/request', (req, next) => {
    try {
      if (!hasPending('stuck')) {
        enqueue({
          kind: 'stuck',
          reason: 'approval',
          toolName: pickString(req?.toolName) ?? null,
        })
      }
    } catch (error) {
      console.error(`[dsh-chime] approval/request handler: ${error?.message ?? error}`)
    }
    return next()
  })

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (exec?.name === 'ask_user_question' && !hasPending('stuck')) {
        enqueue({ kind: 'stuck', reason: 'question', toolName: 'ask_user_question' })
      }
    } catch (error) {
      console.error(`[dsh-chime] tools/pre-execute handler: ${error?.message ?? error}`)
    }
    return next()
  })

  // —— 任务完成：running → idle
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload?.agent
      const status = payload?.status
      if (!agent || typeof agent.id !== 'string') return
      if (status === 'running') {
        running.add(agent.id)
        return
      }
      if (status !== 'idle' || !running.delete(agent.id)) return
      const now = Date.now()
      if (consumeRecentError(agent.id, now)) return
      if (now - lastDoneAt > MERGE_WINDOW_MS && !hasPending('done')) {
        lastDoneAt = now
        enqueue({ kind: 'done' })
      }
    } catch (error) {
      console.error(`[dsh-chime] agent/status handler: ${error?.message ?? error}`)
    }
  })

  // —— 任务失败：真实报错才有 agent/error；用户中止不发这个事件
  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload?.agent
      const now = Date.now()
      if (agent && typeof agent.id === 'string') {
        errorAtByAgent.set(agent.id, now)
        for (const [id, at] of errorAtByAgent) {
          if (now - at > ERROR_WINDOW_MS) errorAtByAgent.delete(id)
        }
      }
      if (now - lastFailAt > MERGE_WINDOW_MS && !hasPending('fail')) {
        lastFailAt = now
        enqueue({
          kind: 'fail',
          turn: typeof payload?.turn === 'number' ? payload.turn : null,
          step: typeof payload?.step === 'number' ? payload.step : null,
        })
      }
    } catch (error) {
      console.error(`[dsh-chime] agent/error handler: ${error?.message ?? error}`)
    }
  })

  // —— 浏览器半边要的三条接口（webServer 只在 web profile 存在）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const routes = [
        {
          name: 'dsh-chime-drain',
          kind: 'exact',
          path: '/chime/drain',
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405).end()
              return
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ items: pending.splice(0, pending.length) }))
          },
        },
        {
          name: 'dsh-chime-state',
          kind: 'exact',
          path: '/chime/state',
          handler: async (req, res) => {
            if (req.method === 'GET') {
              res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ...(lastState ?? DEFAULT_STATE), audioBase: `${audioBase}/` }))
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405).end()
              return
            }
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            let body = {}
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid json' }))
              return
            }
            lastState = normalizeState(body, lastState)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, state: lastState, audioBase: `${audioBase}/` }))
          },
        },
        {
          name: 'dsh-chime-audio',
          kind: 'prefix',
          path: AUDIO_BASES[0],
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405).end()
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            const file = decodeURIComponent(url.pathname.slice(audioBase.length + 1))
            // 白名单文件名，顺带把 ../ 之类挡在外面
            if (!AUDIO_FILE.test(file)) {
              res.writeHead(404, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'bad-name', file }))
              return
            }
            try {
              const data = await readFile(join(SOUNDS_DIR, file))
              const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
              res.writeHead(200, {
                'content-type': MIME[ext] ?? 'application/octet-stream',
                'content-length': String(data.length),
                'cache-control': 'public, max-age=3600',
              })
              res.end(data)
            } catch (error) {
              res.writeHead(404, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: 'read-failed', file, soundsDir: SOUNDS_DIR, message: error?.message ?? String(error) }))
            }
          },
        },
        {
          name: 'dsh-chime-diag',
          kind: 'exact',
          path: '/chime/diag',
          handler: async (req, res) => {
            let files = []
            let listError = null
            try {
              files = (await readdir(SOUNDS_DIR)).filter((entry) => AUDIO_FILE.test(entry))
            } catch (error) {
              listError = error?.message ?? String(error)
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            res.end(JSON.stringify({
              packageDir: PKG_DIR,
              soundsDir: SOUNDS_DIR,
              audioBase: `${audioBase}/`,
              files,
              listError,
              regexOk: AUDIO_FILE.test('done-01.mp3'),
              state: lastState ?? DEFAULT_STATE,
            }))
          },
        },
      ]
      for (const route of routes) {
        const isAudio = route.name === 'dsh-chime-audio'
        const candidates = isAudio ? AUDIO_BASES : [route.path]
        let done = false
        for (const base of candidates) {
          try {
            const spec = isAudio ? { ...route, path: base } : route
            const dispose = scope.webServer.register(spec)
            if (isAudio) audioBase = base
            if (typeof dispose === 'function' && typeof ctx.effect === 'function') ctx.effect(() => dispose)
            done = true
            break
          } catch (error) {
            console.error(`[dsh-chime] route ${base}: ${error?.message ?? error}`)
          }
        }
        if (!done) console.error(`[dsh-chime] route ${route.path}: all candidate bases taken`)
      }
    })
  }

  // —— 给模型用的两只手：看状态、按事件试放
  try {
    ctx.tools.register({
      name: 'chime_status',
      description: '查看提示音插件的面板状态：总开关、音量，以及「完成 / 卡住 / 失败」三个音色槽当前绑了什么。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            volume: { type: 'number' },
            done: { type: 'string' },
            stuck: { type: 'string' },
            fail: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `提示音: 启用=${value.enabled} 音量=${Math.round(value.volume * 100)}% 完成=${value.done} 卡住=${value.stuck} 失败=${value.fail}`,
        }],
      },
      async execute() {
        const state = lastState ?? DEFAULT_STATE
        const label = (slot) => (slot ? `${slot.type === 'builtin' ? '内置' : '导入'}:${slot.name}` : '未设置')
        return {
          enabled: state.enabled,
          volume: state.volume,
          done: label(state.slots.done),
          stuck: label(state.slots.stuck),
          fail: label(state.slots.fail),
        }
      },
    })

    ctx.tools.register({
      name: 'chime_play',
      description: '按事件类型试放一次提示音（走浏览器端同一个播放器，未绑定音色的槽位不会响）。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: KINDS,
            description: 'done 任务完成 / stuck 任务卡住 / fail 任务失败',
          },
        },
        required: ['kind'],
      },
      output: {
        schema: {
          type: 'object',
          properties: { queued: { type: 'string' }, bound: { type: 'boolean' } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.bound ? `已触发 ${value.queued} 提示音` : `已触发 ${value.queued}，但该槽位还没有绑定音色，不会响`,
        }],
      },
      async execute(args) {
        const kind = KINDS.includes(args?.kind) ? args.kind : 'done'
        const state = lastState ?? DEFAULT_STATE
        enqueue({ kind, reason: 'manual' })
        return { queued: kind, bound: Boolean(state.slots[kind]) }
      },
    })
  } catch (error) {
    console.error(`[dsh-chime] tool registration: ${error?.message ?? error}`)
  }
}
