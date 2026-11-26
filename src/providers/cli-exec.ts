import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

/**
 * Orca's plugin worker on Windows may omit APPDATA / LOCALAPPDATA from process.env.
 * Many local CLIs (including `orca.exe`, `opencode`, `codex`, `claude`) depend on them
 * to resolve runtime metadata and user configs. Restore them deterministically from os.homedir().
 */
export function buildChildEnv(
  extra?: NodeJS.ProcessEnv,
  options?: { replaceEnv?: boolean; stripElectronRunAsNode?: boolean }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = options?.replaceEnv
    ? { ...(extra ?? {}) }
    : { ...process.env, ...(extra ?? {}) }

  if (options?.stripElectronRunAsNode) {
    delete env.ELECTRON_RUN_AS_NODE
  }

  if (process.platform === 'win32') {
    const home = env.USERPROFILE || os.homedir()
    if (home) {
      if (!env.USERPROFILE) env.USERPROFILE = home
      if (!env.APPDATA) env.APPDATA = path.join(home, 'AppData', 'Roaming')
      if (!env.LOCALAPPDATA) env.LOCALAPPDATA = path.join(home, 'AppData', 'Local')
    }
  } else if (!env.HOME) {
    const home = os.homedir()
    if (home) env.HOME = home
  }

  return env
}

export type ResolvedExecutable = {
  command: string
  prefixArgs: string[]
  displayPath: string
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveWindowsCmdShim(cmdPath: string): Promise<ResolvedExecutable> {
  const dp0 = path.dirname(cmdPath)
  try {
    const content = await fs.readFile(cmdPath, 'utf8')
    const jsMatch = content.match(/"%dp0%\\([^"\r\n]+\.(?:js|mjs|cjs))"/i)
    if (jsMatch) {
      const jsTarget = path.resolve(dp0, jsMatch[1])
      if (await fileExists(jsTarget)) {
        return {
          command: process.execPath,
          prefixArgs: [jsTarget],
          displayPath: cmdPath
        }
      }
    }
    const exeMatch = content.match(/"%dp0%\\([^"\r\n]+\.exe)"/i)
    if (exeMatch) {
      const exeTarget = path.resolve(dp0, exeMatch[1])
      if (await fileExists(exeTarget)) {
        return {
          command: exeTarget,
          prefixArgs: [],
          displayPath: exeTarget
        }
      }
    }
  } catch {
    // fall through to cmd.exe wrapper
  }

  return {
    command: process.env.ComSpec || 'cmd.exe',
    prefixArgs: ['/d', '/s', '/c', cmdPath],
    displayPath: cmdPath
  }
}

export async function resolveExecutable(name: string): Promise<ResolvedExecutable | null> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where.exe', [name], {
        windowsHide: true,
        timeout: 5_000
      })
      const candidates = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      const exeCandidate = candidates.find((c) => c.toLowerCase().endsWith('.exe'))
      if (exeCandidate) {
        return { command: exeCandidate, prefixArgs: [], displayPath: exeCandidate }
      }

      const cmdCandidate = candidates.find((c) => {
        const lower = c.toLowerCase()
        return lower.endsWith('.cmd') || lower.endsWith('.bat')
      })
      if (cmdCandidate) {
        return resolveWindowsCmdShim(cmdCandidate)
      }

      if (candidates.length > 0) {
        return { command: candidates[0], prefixArgs: [], displayPath: candidates[0] }
      }
    } catch {
      return null
    }
    return null
  }

  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 5_000 })
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (!first) return null
    return { command: first, prefixArgs: [], displayPath: first }
  } catch {
    return null
  }
}

export type SpawnStdinResult = {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
}

function terminateChild(pid: number | undefined, killFallback: () => void): void {
  if (!pid) {
    killFallback()
    return
  }
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.unref()
      return
    } catch {
      // fall back
    }
  }
  killFallback()
}

export async function spawnWithStdin(
  execSpec: ResolvedExecutable,
  args: string[],
  stdinText: string,
  options?: {
    cwd?: string | null
    signal?: AbortSignal
    timeoutMs?: number
    env?: NodeJS.ProcessEnv
    replaceEnv?: boolean
    stripElectronRunAsNode?: boolean
  }
): Promise<SpawnStdinResult> {
  const timeoutMs = options?.timeoutMs ?? 180_000

  return new Promise<SpawnStdinResult>((resolve, reject) => {
    if (options?.signal?.aborted) {
      resolve({ code: null, stdout: '', stderr: 'Aborted', aborted: true, timedOut: false })
      return
    }

    const childEnv = buildChildEnv(options?.env, {
      replaceEnv: options?.replaceEnv,
      stripElectronRunAsNode: options?.stripElectronRunAsNode
    })

    const child = spawn(execSpec.command, [...execSpec.prefixArgs, ...args], {
      cwd: options?.cwd || undefined,
      env: childEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutLen = 0
    let stderrLen = 0
    let aborted = false
    let timedOut = false
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort)
      }
    }

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        aborted,
        timedOut
      })
    }

    const onAbort = () => {
      aborted = true
      terminateChild(child.pid, () => child.kill('SIGTERM'))
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateChild(child.pid, () => child.kill('SIGTERM'))
    }, timeoutMs)

    if (options?.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutLen < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk)
        stdoutLen += chunk.length
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk)
        stderrLen += chunk.length
      }
    })

    child.stdin?.on('error', () => {
      // ignore EPIPE if child closed early
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    })

    child.on('close', (code) => {
      finish(code)
    })

    if (child.stdin) {
      child.stdin.write(stdinText, 'utf8')
      child.stdin.end()
    }
  })
}
