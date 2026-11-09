# dsh-chime

[![ci](https://github.com/chitang233/dsh-chime/actions/workflows/ci.yml/badge.svg)](https://github.com/chitang233/dsh-chime/actions/workflows/ci.yml)

给 DeepSeek Harness 加三类提示音：**任务完成**、**任务卡住**、**任务失败**。
每个事件一个独立音色槽，可以总开关、调音量、导入自己的音频；音频只存在本机浏览器里，不上传。

## 现在是什么状态

`0.2.1` 三条事件各自带一个内置音，**装完就能响**，不导入任何东西也能用：

| 槽位 | 内置音 | 文件 | 来源 |
| --- | --- | --- | --- |
| ✅ 任务完成 | 完成 1 | `sounds/done-01.mp3`（80,064 B） | 沿用原来 `dsh-notify-bird` 的完成音 |
| 🛑 任务卡住 | 卡住 1 | `sounds/stuck-01.mp3`（33,408 B） | 沿用原来 `dsh-notify-bird` 的求确认音 |
| ❌ 任务失败 | 失败 1 | `sounds/fail-01.wav`（108,530 B） | 复刻 `dsh-sonic` 的 `error` 合成音（466→349→233Hz 三声下行三角波） |

`fail-01.wav` 由 `scripts/gen-fail-tone.mjs` 生成，改参数重跑即可换调；它不入 git 二进制历史之外的额外依赖，生成脚本本身就是规格。
老版本装过、槽位为空的安装，首次更新会自动补上这三个默认音；**你自己导入过的槽位不会被覆盖**，清空的槽位也不会被再次塞回来。

## 三类事件怎么判定

| 事件 | 宿主信号 | 说明 |
| --- | --- | --- |
| 任务完成 `done` | `agent/status` 从 `running` 变 `idle` | 子代理批量完成会在 1.5s 内合并成一声 |
| 任务卡住 `stuck` | `approval/request`，或 `tools/pre-execute` 命中 `ask_user_question` | 模型停下来等你批准 / 等你回话，不等就一直卡着 |
| 任务失败 `fail` | `agent/error` | 真实报错才响；你自己按停止走 `aborted`，不响 |

报错后 5 秒内同一个 agent 走到 `idle` 不再补「完成」音，所以一次失败只响失败音，不会失败音 + 完成音连着来。

## 安装

```bash
# 1) 放进 profile
cd ~/.dsh/profiles/<你的 profile 名>
npm install --save dsh-chime   # 或 npm install ./dsh-chime-0.2.1.tgz
# 本地开发直接链目录：
#   "dsh-chime": "link:C:/path/to/dsh-chime"

# 2) 加进 bundles
# dsh.profile.bundles 末尾追加 "dsh-chime"

# 3) 重启 DSH
```

包里的 `cordis.patch.yml` 会在 bundles 出现 `dsh-chime` 时自动挂载插件。

## 使用

**设置 → 通用 → 🔔 提示音**

- 右上角开关：总开关，关掉后队列照常消费但不发声
- 音量滑条：所有提示音共用一个音量
- 三个槽位：`✅ 任务完成` / `🛑 任务卡住` / `❌ 任务失败`
  - `试听` 立刻放一次
  - `导入音频` 选本机 mp3 / wav / ogg / m4a / flac，导入后自动试听一次
  - `清除` 解绑并删掉本机副本

导入的文件存在浏览器的 IndexedDB（库名 `dsh-chime`），绑定关系存在 `localStorage['dsh-chime:state']`，
刷新页面、重启 DSH 都还在；清浏览器数据就一起没了。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `chime_status` | 读面板状态：是否启用、音量、三个槽位各绑了什么 |
| `chime_play` | 按事件类型试放一次（`done` / `stuck` / `fail`），槽位空着就不响 |

## HTTP 接口（浏览器半边用）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/chime/drain` | 取走待播队列 |
| GET | `/chime/state` | 读面板状态 |
| POST | `/chime/state` | 写面板状态 |
| GET | `/chime/audio/<file>` | 取包内 `sounds/` 的内置音色（文件名白名单） |

## 加内置音色

1. 把音频放进 `sounds/`（文件名只能用 `[A-Za-z0-9._-]`，扩展名限 `mp3 wav ogg m4a flac aac`）
2. 在 `dsh/client.js` 的 `BUILTIN` 里加一行：

```js
var BUILTIN = [
  { id: 'done-01', kind: 'done', label: '完成 1', file: 'done-01.mp3' },
  { id: 'done-02', kind: 'done', label: '完成 2', file: 'done-02.mp3' },  // 新增
  { id: 'stuck-01', kind: 'stuck', label: '卡住 1', file: 'stuck-01.mp3' },
  { id: 'fail-01', kind: 'fail', label: '失败 1', file: 'fail-01.wav' },
]
var BUILTIN_VERSION = 2  // 升版本号，老用户才会自动补默认音
```

面板会按 `kind` 自动分组渲染成可点选的小胶囊，点一下试听并绑定，一个槽位可以有多颗胶囊（同一 `kind` 登记几行就有几颗）。
某类不想出声，就不给它登记任何内置音。改完 `BUILTIN` 后浏览器刷新即生效；改宿主 `dsh/index.js` 才需要重启 DSH。

## 已知限制

- 声音在渲染进程里放，**DSH 窗口关掉就不响**，最小化可以
- 浏览器自动播放策略要求页面先有过一次点击或按键，冷启动后第一声可能被吞
- 面板状态存在宿主内存里（进程重启后由浏览器上报恢复），队列不落盘

## License

MIT
