// 打包成可安装的 tgz：node scripts/pack.mjs
// 产物落在仓库根目录，文件名形如 dsh-chime-0.1.0.tgz。
// 安装方可直接 `npm install ./dsh-chime-0.1.0.tgz` 或 `dsh plugin add <路径>`。
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const before = new Set(readdirSync(root).filter((f) => f.endsWith('.tgz')))

const stdout = execFileSync('npm', ['pack', '--silent'], { cwd: root, encoding: 'utf8', shell: true }).trim()
const created = readdirSync(root).filter((f) => f.endsWith('.tgz') && !before.has(f))
const file = created[created.length - 1] ?? stdout.split('\n').pop()

if (!file) {
  console.error('打包失败：没有拿到 tgz 文件名')
  process.exit(1)
}
const size = statSync(join(root, file)).size
console.log(`打包完成：${file}（${(size / 1024).toFixed(1)} KB）`)
console.log(`安装：npm install ./${file}`)
