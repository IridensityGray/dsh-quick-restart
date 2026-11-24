/**
 * 快速刷新与重启插件 —— Host 侧
 *
 * 目标：插件开发时不再手动「退出应用 → 重新打开」。
 *   · Client 侧「刷新页面」：纯前端重载，不需要 Host；见 client.js。
 *   · Client 侧绿色「重启」：POST 本文件注册的本机路由，Host 通过 WMI 起一个
 *     脱离当前进程树的 PowerShell 辅助脚本，由它让桌面应用优雅退出（或兜底强制
 *     结束）、等待 Host 进程退出，再用原命令行重启应用。
 *
 * 为什么必须有外部 helper：桌面应用把「关闭窗口」实现成隐藏到托盘（Windows），
 * 而 app.quit() 只能在主进程内部调用。Host 是 Electron 主进程的子进程，插件代码
 * 无法直接让主进程退出，所以由 helper 从外部完成：
 *   1) WM_QUERYENDSESSION + WM_CLOSE —— 让外壳把它当成真实会话结束而走正常退出流程；
 *   2) 若 7 秒后仍未退出，强制结束主进程；Host 在 IPC 断开时仍会优雅收尾；
 *   3) 等 Host 退出后重新启动应用（保留原命令行参数）。
 *
 * 为什么用 WMI：DSH 在 Job Object 里运行工具与插件命令行，随它退出的子进程会被一并
 * 结束；helper 必须先于应用退出而存活，所以由 WMI 服务（WmiPrvSE.exe）创建它，
 * 它不在该 Job 里。
 *
 * 与 Client 的通道：本机回环 HTTP
 *   POST /plugin-http/dsh-quick-restart  { "action": "restart" | "status" | "probe" }
 *   -> { ok: true, data } | { ok: false, error }
 *
 * 重启是两步：restart 只负责「检查 + 启动 helper」，客户端随后用 status 追问结果，
 * 所以 helper 启动前的失败（例如不是桌面版）会以错误提示出现，而不是一个假的
 * 「重启中」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'quick-restart'

const PACKAGE_NAME = '@iridensity_gray/dsh-quick-restart'
const ROUTE = '/plugin-http/dsh-quick-restart'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPER = path.join(HERE, 'restart.ps1')
/** How long the route waits for the helper to confirm it is alive. */
const MARKER_WAIT_MS = 12_000
/** How long the module remembers a restart, for `status` and result reporting. */
const REQUEST_MEMORY_MS = 2 * 60 * 1000
/** A request newer than this is answered with its remembered outcome unless it fails. */
const REQUEST_REUSE_MS = 30_000

let restartRequest = null

function log (ctx, level, message) {
  try {
    const logger = ctx?.logger
    if (logger !== undefined && typeof logger[level] === 'function') logger[level]('quick-restart: ' + message)
  } catch {
    /* logging must never break the restart */
  }
}

function messageOf (error) {
  return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
}

function exists (file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

function logDir () {
  return path.join(os.tmpdir(), 'dsh-quick-restart')
}

/** Windows PowerShell; the desktop app always ships it. */
function powerShellPath () {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  if (typeof systemRoot === 'string' && systemRoot !== '') {
    const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(candidate)) return candidate
  }
  return 'powershell.exe'
}

/** A failure with a machine-readable code the Client maps to localized copy. */
function failure (code, detail) {
  return { ok: false, code, detail }
}

/**
 * Facts the restart needs, without touching anything.
 * @returns {{ ok: true, exe: string, appPid: number } | { ok: false, code: string, detail: string }}
 */
function resolveTarget () {
  if (process.platform !== 'win32') return failure('unsupported-platform', 'restart requires the Windows desktop app')
  if (process.versions.electron === undefined) return failure('not-desktop', 'the Host does not run inside the desktop app')
  const fromEnv = process.env.DSH_NODE_EXECUTABLE
  const exe = typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : process.execPath
  if (typeof exe !== 'string' || exe === '' || !/\.exe$/i.test(exe)) {
    return failure('executable-unknown', 'the desktop executable is unknown')
  }
  if (!exists(exe)) return failure('executable-missing', 'the desktop executable is missing: ' + exe)
  if (!exists(HELPER)) return failure('helper-missing', 'restart.ps1 is missing next to the plugin')
  const appPid = Number(process.ppid)
  if (!Number.isInteger(appPid) || appPid <= 0) return failure('process-unknown', 'the desktop process cannot be identified')
  return { ok: true, exe, appPid }
}

function capability () {
  const target = resolveTarget()
  return {
    platform: process.platform,
    electron: process.versions.electron !== undefined,
    helperReady: exists(HELPER),
    targetReady: target.ok,
    reason: target.ok ? '' : target.detail,
    hostPid: process.pid,
    logDir: logDir(),
  }
}

/**
 * Run one Windows PowerShell command line and collect its output.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runPowerShell (args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(powerShellPath(), args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const text = typeof stderr === 'string' ? stderr.trim() : ''
      if (error !== null && error !== undefined) {
        reject(new Error(messageOf(error) + (text === '' ? '' : ': ' + text)))
        return
      }
      resolve({ stdout: typeof stdout === 'string' ? stdout : '', stderr: text })
    })
  })
}

function sleep (ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Escape a value for a PowerShell single-quoted string. */
function psQuote (value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}

/**
 * Read the marker file the WMI-started helper writes with its own PID.
 * @returns {number | undefined} the helper PID once the marker is complete.
 */
function readMarker (file, key) {
  if (!exists(file)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const pid = parsed?.[key]
    return Number.isInteger(pid) ? pid : undefined
  } catch {
    // The script may still be writing the file.
    return undefined
  }
}

/**
 * Ask the WMI service to start the helper script outside this process tree.
 * @returns {Promise<{ pid: number, resultFile: string }>} the helper's own PID and
 *   the file it writes a failure reason into.
 */
async function launchThroughWmi (target) {
  const dir = logDir()
  fs.mkdirSync(dir, { recursive: true })
  const markerKey = `child-${process.pid}-${Date.now()}`
  const markerFile = path.join(dir, markerKey + '.json')
  try { fs.rmSync(markerFile, { force: true }) } catch { /* no stale marker */ }
  // Keep the log directory small; these files are diagnostics only.
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('restart-') && !name.startsWith('child-') && !name.startsWith('result-')) continue
      const full = path.join(dir, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
      } catch { /* keep whatever cannot be removed */ }
    }
  } catch { /* pruning is best effort */ }

  const commandLine = [
    `"${powerShellPath()}"`,
    '-NoLogo', '-NoProfile', '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', `"${HELPER}"`,
    '-AppExe', `"${target.exe}"`,
    '-AppPid', String(target.appPid),
    '-HostPidArg', String(process.pid),
    '-MarkerKey', markerKey,
    '-Child', '1',
  ].join(' ')
  const statement = [
    "$ErrorActionPreference = 'Stop'",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)} }`,
    'if ($result.ReturnValue -ne 0) { throw ("Win32_Process.Create failed: " + $result.ReturnValue) }',
  ].join('; ')
  await runPowerShell(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', statement], 20_000)

  const deadline = Date.now() + MARKER_WAIT_MS
  while (Date.now() < deadline) {
    const pid = readMarker(markerFile, markerKey)
    if (pid !== undefined) {
      try { fs.rmSync(markerFile, { force: true }) } catch { /* best effort */ }
      return { pid, resultFile: path.join(dir, `result-${pid}.txt`) }
    }
    await sleep(150)
  }
  throw new Error('the restart helper did not start within ' + String(MARKER_WAIT_MS / 1000) + ' s')
}

/** Whether a process id is still alive (0 is treated as alive: no such pid). */
function isAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Read the helper's failure report, if it already wrote one.
 * @returns {string | undefined} the reason, or undefined while none exists.
 */
function readResult (file) {
  if (typeof file !== 'string' || file === '' || !exists(file)) return undefined
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

/**
 * Start the helper outside the current process job. The result is remembered so
 * the Client can also ask for it through `status`.
 * @returns {Promise<{ ok: boolean, pid?: number, code?: string, detail?: string, already?: boolean }>}
 */
function startRestart (ctx) {
  const previous = restartRequest
  if (previous !== null && Date.now() - previous.startedAt < REQUEST_REUSE_MS && previous.promise !== undefined) {
    return previous.promise.then((value) => {
      // A failed attempt may be retried at once; a live one is reused.
      if (value.ok || value.code !== 'launch-failed') return { ...value, already: true }
      restartRequest = null
      return startRestart(ctx)
    })
  }
  const entry = { startedAt: Date.now(), phase: 'launching', pid: undefined, resultFile: '', code: undefined, detail: undefined }
  entry.promise = (async () => {
    const target = resolveTarget()
    if (!target.ok) {
      entry.phase = 'failed'
      entry.code = target.code
      entry.detail = target.detail
      return target
    }
    try {
      const launched = await launchThroughWmi(target)
      entry.phase = 'launched'
      entry.pid = launched.pid
      entry.resultFile = launched.resultFile
      log(ctx, 'info', `restart launched; exe=${target.exe} appPid=${target.appPid} hostPid=${process.pid} helperPid=${launched.pid}`)
      return { ok: true, pid: launched.pid }
    } catch (error) {
      entry.phase = 'failed'
      entry.code = 'launch-failed'
      entry.detail = messageOf(error)
      log(ctx, 'warn', 'restart helper launch failed: ' + entry.detail)
      return { ok: false, code: entry.code, detail: entry.detail }
    }
  })()
  restartRequest = entry
  return entry.promise
}

/**
 * The build revision of the served Client bundle for this package, if the module
 * system exposes one. The Client compares it with the revision its page loaded.
 */
function moduleRevision (ctx) {
  try {
    const modules = ctx.get('clientModules')
    if (modules === undefined || typeof modules.graph !== 'function') return ''
    const graph = modules.graph()
    const rows = Array.isArray(graph?.modules) ? graph.modules : []
    const row = rows.find(candidate => candidate?.id === PACKAGE_NAME)
    return typeof row?.rev === 'string' ? row.rev : ''
  } catch {
    return ''
  }
}

/** Describe the remembered restart request and this bundle's build revision. */
function restartStatus (ctx) {
  const revision = moduleRevision(ctx)
  const entry = restartRequest
  if (entry === null || Date.now() - entry.startedAt > REQUEST_MEMORY_MS) {
    return { phase: 'idle', ageMs: 0, moduleRevision: revision }
  }
  const ageMs = Date.now() - entry.startedAt
  if (entry.phase === 'launched' && !isAlive(entry.pid)) {
    // The helper is gone. It never outlives a successful restart, so a report
    // file means it stopped before or while relaunching the app.
    const reason = readResult(entry.resultFile)
    if (reason !== undefined) {
      entry.phase = 'failed'
      entry.code = 'helper-failed'
      entry.detail = reason
    }
  }
  const status = { phase: entry.phase, ageMs, moduleRevision: moduleRevision(ctx) }
  if (typeof entry.pid === 'number') status.helperPid = entry.pid
  if (typeof entry.code === 'string') status.code = entry.code
  if (typeof entry.detail === 'string') status.detail = entry.detail
  return status
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256_000) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

function sendJson (res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function isLoopback (address) {
  const value = String(address ?? '')
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function makeRoute (ctx) {
  return async (req, res) => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, code: 'remote', error: 'loopback requests only' })
        return
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
        return
      }
      let args
      try {
        args = JSON.parse((await readBody(req)) || '{}')
      } catch {
        sendJson(res, 400, { ok: false, code: 'bad-json', error: 'the body is not valid JSON' })
        return
      }
      const action = String(args?.action ?? '')
      if (action === 'probe') {
        sendJson(res, 200, { ok: true, data: capability() })
        return
      }
      if (action === 'status') {
        sendJson(res, 200, { ok: true, data: restartStatus(ctx) })
        return
      }
      if (action !== 'restart') {
        sendJson(res, 400, { ok: false, code: 'unknown-action', error: 'unknown action: ' + action })
        return
      }
      const result = await startRestart(ctx)
      if (!result.ok) {
        sendJson(res, 409, { ok: false, code: result.code, error: result.detail })
        return
      }
      sendJson(res, 202, { ok: true, data: { scheduled: true, already: result.already === true, helperPid: result.pid } })
    } catch (error) {
      log(ctx, 'warn', 'route failed: ' + messageOf(error))
      sendJson(res, 500, { ok: false, code: 'internal', error: messageOf(error) })
    }
  }
}

export function apply (ctx) {
  ctx.inject(['webServer'], (scope) => {
    scope.effect(
      () => scope.get('webServer').register({ kind: 'exact', path: ROUTE, handler: makeRoute(ctx) }),
      'quick-restart: route',
    )
  })
  ctx.effect(() => {
    log(ctx, 'info', 'ready')
    return () => {}
  }, 'quick-restart: mount')
}
