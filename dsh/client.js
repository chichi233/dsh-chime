// dsh-chime — Browser half (static bundle plugin)
//
// 手写 lazy-CJS 协议：window.__ModuleLoader__.load({ id, factory })，factory 拿到
// 平台模块表里的 require（react 是种子词）。无构建步骤、无 dsh 包依赖。
//
// 职责：
//   1. 每秒 GET /chime/drain，把宿主压进队列的事件按 kind 播出来
//      （done 完成 / stuck 卡住 / fail 失败）。
//   2. 设置 → 通用 里挂一行面板：总开关、音量、三个音色槽的绑定与导入。
//   3. 导入的音频存 IndexedDB（刷新和重启都还在），绑定关系存 localStorage，
//      同时 POST /chime/state 让宿主和模型工具看到同一份状态。
//
// 内置音色：三类事件各带一个默认音，装好就能响。加音色两步——把音频放进
// 包里的 sounds/，再往 BUILTIN 里登记一行（kind 决定它出现在哪一行）。
window.__ModuleLoader__.load({
  id: 'dsh-chime',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    /** 内置音色池 —— kind 决定出现在哪一行，file 走宿主 /chime/audio/ 路由取字节。
     *  done-01 / stuck-01：原 dsh-notify-bird 的两个声音（用户在用、直接收进来）
     *  fail-01：复刻 dsh-sonic 的 error 合成音（scripts/gen-fail-tone.mjs 生成） */
    var BUILTIN = [
      { id: 'done-01', kind: 'done', label: '完成 1', file: 'done-01.mp3' },
      { id: 'stuck-01', kind: 'stuck', label: '卡住 1', file: 'stuck-01.mp3' },
      { id: 'fail-01', kind: 'fail', label: '失败 1', file: 'fail-01.wav' },
    ]
    /** 内置音色版本号：升版时给「还没选音色」的槽位补默认音，用户自己导入的不动。 */
    var BUILTIN_VERSION = 1

    var KINDS = [
      { key: 'done', title: '✅ 任务完成', hint: '任务跑完了' },
      { key: 'stuck', title: '🛑 任务卡住', hint: '模型在等你回话 / 等你批准' },
      { key: 'fail', title: '❌ 任务失败', hint: '执行报错退出（手动中止不算）' },
    ]
    var STORAGE_KEY = 'dsh-chime:state'
    /** 内置音的基址：正常是 /chime/audio/，宿主那条 prefix 路由被占时会退到备用基址，由 /chime/state 告知。 */
    var audioBase = '/chime/audio/'
    var DB_NAME = 'dsh-chime'
    var DB_STORE = 'sounds'

    var state = { enabled: true, volume: 0.6, slots: { done: null, stuck: null, fail: null } }
    /** kind -> { name, blob }，IndexedDB 的镜像，播放时直接用 */
    var blobs = { done: null, stuck: null, fail: null }

    var findBuiltin = function (id) {
      for (var i = 0; i < BUILTIN.length; i++) if (BUILTIN[i].id === id) return BUILTIN[i]
      return null
    }
    var builtinsFor = function (kind) {
      return BUILTIN.filter(function (entry) { return entry.kind === kind })
    }

    // ---------- IndexedDB：导入的音频 ----------
    var openDb = function () {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = function () {
          if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
        }
        req.onsuccess = function () { resolve(req.result) }
        req.onerror = function () { reject(req.error) }
      })
    }
    var withTx = function (mode, run) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(DB_STORE, mode)
          var store = tx.objectStore(DB_STORE)
          var out
          try { out = run(store) } catch (error) { reject(error); return }
          tx.oncomplete = function () { db.close(); resolve(out && 'result' in out ? out.result : undefined) }
          tx.onerror = function () { db.close(); reject(tx.error) }
        })
      })
    }
    var dbPut = function (kind, record) {
      return withTx('readwrite', function (store) { return store.put(record, kind) })
    }
    var dbDelete = function (kind) {
      return withTx('readwrite', function (store) { return store.delete(kind) })
    }
    var dbLoadAll = function () {
      return withTx('readonly', function (store) {
        var out = { result: {} }
        var req = store.openCursor()
        req.onsuccess = function () {
          var cursor = req.result
          if (!cursor) return
          out.result[cursor.key] = cursor.value
          cursor.continue()
        }
        return out
      })
    }

    // ---------- 播放 ----------
    var playSrc = function (src, revoke) {
      var audio = new Audio(src)
      audio.volume = state.volume
      if (revoke) audio.addEventListener('ended', function () { URL.revokeObjectURL(src) })
      var started = audio.play()
      if (started && typeof started.catch === 'function') started.catch(function () {})
    }
    var playKind = function (kind) {
      if (!state.enabled) return false
      var slot = state.slots[kind]
      if (!slot) return false
      if (slot.type === 'builtin') {
        var entry = findBuiltin(slot.id)
        if (!entry) return false
        playSrc(audioBase + entry.file)
        return true
      }
      var record = blobs[kind]
      if (!record || !record.blob) return false
      playSrc(URL.createObjectURL(record.blob), true)
      return true
    }

    // ---------- 状态：本地存 + 上报宿主 ----------
    var save = function () {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch {}
      fetch('/chime/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(function () {})
    }
    /** 空槽位补默认内置音；用户选过的、导入过的一律不动。 */
    var seedDefaults = function (savedVersion) {
      if (savedVersion === BUILTIN_VERSION) return
      for (var i = 0; i < KINDS.length; i++) {
        var kind = KINDS[i].key
        if (state.slots[kind]) continue
        var list = builtinsFor(kind)
        if (list.length) {
          state.slots[kind] = { type: 'builtin', id: list[0].id, name: list[0].label, file: list[0].file }
        }
      }
      state.builtinVersion = BUILTIN_VERSION
    }
    var loadLocal = function () {
      var savedVersion = 0
      try {
        var raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) { seedDefaults(0); return }
        var saved = JSON.parse(raw)
        if (!saved || typeof saved !== 'object') { seedDefaults(0); return }
        if (typeof saved.builtinVersion === 'number') savedVersion = saved.builtinVersion
        if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled
        if (typeof saved.volume === 'number') state.volume = saved.volume
        if (saved.slots && typeof saved.slots === 'object') {
          for (var i = 0; i < KINDS.length; i++) {
            var kind = KINDS[i].key
            var slot = saved.slots[kind]
            state.slots[kind] = slot && (slot.type === 'builtin' || slot.type === 'imported') ? slot : null
          }
          // 老版本存的绑定可能没带 file（宿主的 pickSlot 会当无效槽丢掉），就地补齐
          for (var j = 0; j < KINDS.length; j++) {
            var oldKind = KINDS[j].key
            var oldSlot = state.slots[oldKind]
            if (!oldSlot || oldSlot.type !== 'builtin') continue
            var builtin = findBuiltin(oldSlot.id)
            state.slots[oldKind] = builtin
              ? { type: 'builtin', id: builtin.id, name: builtin.label, file: builtin.file }
              : null
          }
        }
      } catch {}
      seedDefaults(savedVersion)
    }
    var hydrate = function () {
      return dbLoadAll().then(function (records) {
        for (var i = 0; i < KINDS.length; i++) {
          var kind = KINDS[i].key
          var record = records && records[kind]
          blobs[kind] = record && record.blob ? { name: record.name, blob: record.blob } : null
          // 存过绑定但音频没了（清过浏览器数据），把绑定一起清掉，免得面板撒谎
          if (state.slots[kind] && state.slots[kind].type === 'imported' && !blobs[kind]) state.slots[kind] = null
          if (state.slots[kind] && state.slots[kind].type === 'builtin') {
            var builtin = findBuiltin(state.slots[kind].id)
            if (!builtin) state.slots[kind] = null
            else if (state.slots[kind].file !== builtin.file) state.slots[kind] = { type: 'builtin', id: builtin.id, name: builtin.label, file: builtin.file }
          }
        }
        save()
      }).catch(function () {})
    }

    /** 从宿主取实际生效的音频基址（备用基址时 /chime/audio/ 会被僵尸路由挡住）。 */
    var syncAudioBase = function () {
      return fetch('/chime/state').then(function (r) { return r.json() }).then(function (data) {
        if (data && typeof data.audioBase === 'string' && data.audioBase) audioBase = data.audioBase
      }).catch(function () {})
    }

    var poll = function () {
      fetch('/chime/drain').then(function (r) { return r.json() }).then(function (data) {
        var items = data && Array.isArray(data.items) ? data.items : []
        for (var i = 0; i < items.length; i++) {
          var item = items[i]
          if (item && typeof item.kind === 'string') playKind(item.kind)
        }
      }).catch(function () {})
    }

    // ---------- 面板 ----------
    var slotLabel = function (slot) {
      if (!slot) return '未设置'
      if (slot.type === 'builtin') {
        var entry = findBuiltin(slot.id)
        return '内置 · ' + (entry ? entry.label : slot.id)
      }
      return '导入 · ' + (slot.name || '自定义音频')
    }

    function ChimeSettings() {
      var tickPair = React.useState(0)
      var bump = function () { tickPair[1](function (n) { return n + 1 }) }
      var fileRef = React.useRef(null)
      var targetRef = React.useRef(null)
      React.useEffect(function () { bump() }, [])

      var pickFile = function (kind) {
        targetRef.current = kind
        if (fileRef.current) fileRef.current.click()
      }
      var onFile = function (event) {
        var file = event.target.files && event.target.files[0]
        var kind = targetRef.current
        event.target.value = ''
        if (!file || !kind) return
        dbPut(kind, { name: file.name, type: file.type, blob: file, addedAt: Date.now() }).then(function () {
          blobs[kind] = { name: file.name, blob: file }
          state.slots[kind] = { type: 'imported', name: file.name }
          save()
          bump()
          window.setTimeout(function () { playKind(kind) }, 80)
        }).catch(function (error) { console.error('[dsh-chime] import failed', error) })
      }
      var clearSlot = function (kind) {
        dbDelete(kind).catch(function () {}).then(function () {
          blobs[kind] = null
          state.slots[kind] = null
          save()
          bump()
        })
      }
      var bindBuiltin = function (kind, entry) {
        state.slots[kind] = { type: 'builtin', id: entry.id, name: entry.label, file: entry.file }
        save()
        bump()
        playKind(kind)
      }

      var rows = KINDS.map(function (meta) {
        var kind = meta.key
        var slot = state.slots[kind]
        var presets = builtinsFor(kind)
        var chips = presets.map(function (entry) {
          var on = slot && slot.type === 'builtin' && slot.id === entry.id
          return React.createElement('button', {
            key: entry.id,
            type: 'button',
            className: 'dsh-chime-chip' + (on ? ' dsh-chime-chip--on' : ''),
            onClick: function () { bindBuiltin(kind, entry) },
          }, entry.label)
        })
        return React.createElement('div', { key: kind, className: 'dsh-chime-row' },
          React.createElement('div', { className: 'dsh-chime-row-head' },
            React.createElement('span', { className: 'dsh-chime-row-title' }, meta.title),
            React.createElement('span', { className: 'dsh-chime-row-hint' }, meta.hint),
          ),
          presets.length > 0 ? React.createElement('div', { className: 'dsh-chime-chips' }, chips) : null,
          React.createElement('div', { className: 'dsh-chime-row-body' },
            React.createElement('span', { className: 'dsh-chime-current' }, slotLabel(slot)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-chime-btn',
              onClick: function () { playKind(kind) },
            }, '试听'),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-chime-btn',
              onClick: function () { pickFile(kind) },
            }, slot && slot.type === 'imported' ? '换一个' : '导入音频'),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-chime-btn dsh-chime-btn--ghost',
              disabled: !slot,
              onClick: function () { clearSlot(kind) },
            }, '清除'),
          ),
        )
      })

      return React.createElement('div', { className: 'dsh-chime' },
        React.createElement('div', { className: 'dsh-chime-header' },
          React.createElement('span', { className: 'dsh-chime-title' }, '🔔 提示音'),
          React.createElement('label', { className: 'dsh-chime-toggle' },
            React.createElement('input', {
              type: 'checkbox',
              checked: state.enabled,
              onChange: function (event) {
                state.enabled = event.target.checked
                save()
                bump()
              },
            }),
            React.createElement('span', null, state.enabled ? '已开启' : '已关闭'),
          ),
        ),
        React.createElement('div', { className: 'dsh-chime-row' },
          React.createElement('span', { className: 'dsh-chime-row-hint' }, '音量'),
          React.createElement('input', {
            className: 'dsh-chime-range',
            type: 'range',
            min: 0,
            max: 1,
            step: 0.05,
            value: state.volume,
            onChange: function (event) {
              state.volume = Number(event.target.value)
              save()
              bump()
            },
          }),
          React.createElement('span', { className: 'dsh-chime-vol' }, Math.round(state.volume * 100) + '%'),
        ),
        rows,
        React.createElement('input', {
          ref: fileRef,
          type: 'file',
          accept: 'audio/*',
          style: { display: 'none' },
          onChange: onFile,
        }),
        BUILTIN.length === 0
          ? React.createElement('div', { className: 'dsh-chime-hint' }, '本版本还没带内置音色，三个槽位都是空的：先导入自己的 mp3 / wav / ogg 用起来。')
          : React.createElement('div', { className: 'dsh-chime-hint' }, '点内置音色立即试听并绑定；也可以导入自己的音频，文件存在本机浏览器里，不上传。'),
      )
    }

    // ---------- 插件本体 ----------
    var STYLE = [
      '.dsh-chime { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 13px; }',
      '.dsh-chime-header { display: flex; align-items: center; justify-content: space-between; }',
      '.dsh-chime-title { font-weight: 600; }',
      '.dsh-chime-toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--dsw-alias-label-secondary); user-select: none; }',
      '.dsh-chime-row { display: flex; flex-direction: column; gap: 4px; }',
      '.dsh-chime-row-head { display: flex; align-items: baseline; gap: 8px; }',
      '.dsh-chime-row-title { font-weight: 500; }',
      '.dsh-chime-row-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }',
      '.dsh-chime-row-body { display: flex; align-items: center; gap: 6px; }',
      '.dsh-chime-current { flex: 1; color: var(--dsw-alias-label-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.dsh-chime-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 2px 10px; font-size: 12px; cursor: pointer; line-height: 1.6; }',
      '.dsh-chime-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }',
      '.dsh-chime-btn:disabled { opacity: .45; cursor: not-allowed; }',
      '.dsh-chime-btn--ghost { background: transparent; }',
      '.dsh-chime-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
      '.dsh-chime-chip { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }',
      '.dsh-chime-chip--on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); font-weight: 600; }',
      '.dsh-chime-range { flex: 1; }',
      '.dsh-chime-vol { min-width: 38px; text-align: right; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }',
      '.dsh-chime-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; }',
    ].join(' ')

    exports.name = 'dsh-chime'
    exports.inject = []
    exports.apply = function (ctx) {
      loadLocal()

      var slots = ctx.get('slots')
      if (slots) {
        slots.inject('settings.general.item', function () {
          return slots.register(
            { name: 'settings.general.item', id: 'dsh-chime' },
            function () { return React.createElement(ChimeSettings, null) },
          )
        })
      }

      var style = document.createElement('style')
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(function () {
        return function () {
          if (style.parentNode) style.parentNode.removeChild(style)
        }
      })

      syncAudioBase()
      hydrate()
      save()
      var timer = setInterval(poll, 1000)
      ctx.effect(function () {
        return function () { clearInterval(timer) }
      })
      poll()
    }

    return module.exports
  },
})
