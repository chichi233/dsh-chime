// 生成内置「任务失败」提示音：复刻 dsh-sonic 的 error 预设（三个下行的三角波）。
// 输出 sounds/fail-01.wav（44.1kHz / 单声道 / 16bit），体积小、无依赖、不用占位符。
// 用法：node scripts/gen-fail-tone.mjs
//
// dsh-sonic 的 error 原始参数（Web Audio，playPreset 会给每个音符加 0.03s 起步偏移）：
//   { freq: 466.16, at: 0,    dur: 0.22, gain: 0.30 }   // A#4
//   { freq: 349.23, at: 0.20, dur: 0.26, gain: 0.30 }   // F4
//   { freq: 233.08, at: 0.42, dur: 0.72, gain: 0.32 }   // A#3
// 包络同样照抄：起音 8ms 指数上升，之后指数衰减到 -78dB。
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 44100
const LEAD_IN = 0.03
const ATTACK = 0.008
const FLOOR = 0.0001
const TAIL = 0.06
const NOTES = [
  { freq: 466.16, at: 0, dur: 0.22, gain: 0.3 },
  { freq: 349.23, at: 0.2, dur: 0.26, gain: 0.3 },
  { freq: 233.08, at: 0.42, dur: 0.72, gain: 0.32 },
]

const end = Math.max(...NOTES.map((n) => n.at + n.dur))
const frames = Math.ceil((LEAD_IN + end + TAIL) * SR)
const mix = new Float32Array(frames)

/** Web Audio 的指数包络：attack 内从 FLOOR 涨到 peak，之后指数衰减回 FLOOR。 */
const envelope = (t, dur, peak) => {
  if (t < 0 || t > dur) return 0
  if (t < ATTACK) return FLOOR * Math.pow(peak / FLOOR, t / ATTACK)
  return peak * Math.pow(FLOOR / peak, (t - ATTACK) / Math.max(dur - ATTACK, 1e-6))
}
/** 三角波：2/π·asin(sin φ) 与振荡器的 'triangle' 一致（同相位、同幅度）。 */
const triangle = (phase) => (2 / Math.PI) * Math.asin(Math.sin(phase))

for (const note of NOTES) {
  const start = LEAD_IN + note.at
  const first = Math.round(start * SR)
  const count = Math.round(note.dur * SR)
  for (let i = 0; i < count; i += 1) {
    const t = i / SR
    const index = first + i
    if (index >= frames) break
    mix[index] += triangle(2 * Math.PI * note.freq * t) * envelope(t, note.dur, note.gain)
  }
}

// 归一化到 -1.5dB，避免叠加后削顶
let peak = 0
for (const v of mix) peak = Math.max(peak, Math.abs(v))
const scale = peak > 0 ? 0.84 / peak : 1

const data = Buffer.alloc(frames * 2)
for (let i = 0; i < frames; i += 1) {
  const sample = Math.max(-1, Math.min(1, mix[i] * scale))
  data.writeInt16LE(Math.round(sample * 32767), i * 2)
}

const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(SR, 24)
header.writeUInt32LE(SR * 2, 28) // byte rate
header.writeUInt16LE(2, 32) // block align
header.writeUInt16LE(16, 34) // bits
header.write('data', 36)
header.writeUInt32LE(data.length, 40)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds', 'fail-01.wav')
writeFileSync(out, Buffer.concat([header, data]))
console.log(`写出 ${out}（${(header.length + data.length) / 1024 | 0} KB，${(frames / SR).toFixed(3)}s）`)
