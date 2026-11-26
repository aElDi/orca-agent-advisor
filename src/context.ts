import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { ContextSummary } from './types'

const execFileAsync = promisify(execFile)

const MAX_FILE_CHARS_DEFAULT = 16_000
const MAX_TOTAL_FILES_CHARS_DEFAULT = 48_000
const MAX_SINGLE_FILE_BYTES = 512 * 1024
const MAX_UNTRACKED_PREVIEW_FILES = 12
const MAX_UNTRACKED_FILE_BYTES = 32 * 1024

export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

export function redactSecretPatterns(input: string): string {
  return input
    .replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/sk-or-v1-[A-Za-z0-9]{10,}/g, '[REDACTED_OPENROUTER_KEY]')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_GOOGLE_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]')
    .replace(
      /((?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*[=:]\s*['"]?)[^\s'"\r\n]{8,}/gi,
      '$1[REDACTED]'
    )
}

export function isSensitiveRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  const base = path.posix.basename(normalized).toLowerCase()
  if (
    base === '.env' ||
    (base.startsWith('.env.') &&
      base !== '.env.example' &&
      base !== '.env.sample' &&
      base !== '.env.template')
  ) {
    return true
  }
  if (
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.endsWith('.p12') ||
    base.endsWith('.pfx') ||
    base === 'id_rsa' ||
    base === 'id_ed25519' ||
    base === 'credentials.json' ||
    base === '.npmrc' ||
    base === '.netrc'
  ) {
    return true
  }
  return false
}

export function isPathInside(rootReal: string, candidateReal: string): boolean {
  const normRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal
  const normCand = process.platform === 'win32' ? candidateReal.toLowerCase() : candidateReal
  if (normRoot === normCand) return true
  const rel = path.relative(normRoot, normCand)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000
    })
    return stdout
  } catch {
    return null
  }
}

export type DiffStatsResult = {
  isGitRepo: boolean
  branch: string | null
  headSha: string | null
  statusShort: string
  diffStat: string
  diffText: string
  diffTruncated: boolean
  added: number
  removed: number
  files: number
  changedLines: number
  diffHash: string
}

function parseNumstat(raw: string | null, fileSet: Set<string>): { added: number; removed: number } {
  if (!raw) return { added: 0, removed: 0 }
  let added = 0
  let removed = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const addNum = Number.parseInt(parts[0], 10)
    const remNum = Number.parseInt(parts[1], 10)
    const fileName = parts.slice(2).join('\t').trim()
    if (fileName) fileSet.add(fileName)
    if (Number.isFinite(addNum)) added += addNum
    if (Number.isFinite(remNum)) removed += remNum
  }
  return { added, removed }
}

function parseUntrackedPaths(statusPorcelain: string | null): string[] {
  if (!statusPorcelain) return []
  const paths: string[] = []
  for (const line of statusPorcelain.split(/\r?\n/)) {
    if (!line.startsWith('?? ')) continue
    let rel = line.slice(3).trim()
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1)
    }
    if (!rel || rel.endsWith('/')) continue
    paths.push(rel)
  }
  return paths
}

export async function computeDiffStats(
  workspacePath: string,
  maxDiffChars = 24_000
): Promise<DiffStatsResult> {
  const inside = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside || inside.trim() !== 'true') {
    return {
      isGitRepo: false,
      branch: null,
      headSha: null,
      statusShort: '',
      diffStat: '',
      diffText: '',
      diffTruncated: false,
      added: 0,
      removed: 0,
      files: 0,
      changedLines: 0,
      diffHash: 'non-git'
    }
  }

  const [branchRaw, headRaw, statusRaw, unstagedNum, stagedNum, unstagedStat, stagedStat, unstagedDiff, stagedDiff] =
    await Promise.all([
      runGit(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      runGit(workspacePath, ['rev-parse', '--short', 'HEAD']),
      runGit(workspacePath, ['status', '--short', '-uall']),
      runGit(workspacePath, ['diff', '--numstat']),
      runGit(workspacePath, ['diff', '--cached', '--numstat']),
      runGit(workspacePath, ['diff', '--stat']),
      runGit(workspacePath, ['diff', '--cached', '--stat']),
      runGit(workspacePath, ['diff', '--unified=3']),
      runGit(workspacePath, ['diff', '--cached', '--unified=3'])
    ])

  const branch = branchRaw?.trim() || null
  const headSha = headRaw?.trim() || null
  const statusShort = (statusRaw ?? '').trim()

  const fileSet = new Set<string>()
  const uCounts = parseNumstat(unstagedNum, fileSet)
  const sCounts = parseNumstat(stagedNum, fileSet)
  let added = uCounts.added + sCounts.added
  let removed = uCounts.removed + sCounts.removed

  const untrackedPaths = parseUntrackedPaths(statusRaw)
  const untrackedSections: string[] = []
  let rootReal: string | null = null
  try {
    rootReal = await fs.realpath(workspacePath)
  } catch {
    rootReal = null
  }

  for (const rel of untrackedPaths.slice(0, MAX_UNTRACKED_PREVIEW_FILES)) {
    fileSet.add(rel)
    if (isSensitiveRelativePath(rel) || !rootReal) continue
    try {
      const candidate = path.resolve(workspacePath, rel)
      const candReal = await fs.realpath(candidate)
      if (!isPathInside(rootReal, candReal)) continue
      const stat = await fs.stat(candReal)
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_FILE_BYTES) continue
      const buf = await fs.readFile(candReal)
      if (isBinaryBuffer(buf)) continue
      const text = buf.toString('utf8')
      const lineCount = text === '' ? 0 : text.split(/\r?\n/).length
      added += lineCount
      untrackedSections.push(`--- /dev/null\n+++ b/${rel}\n${text.slice(0, 4000)}`)
    } catch {
      // ignore unreadable untracked file
    }
  }
  for (const rel of untrackedPaths.slice(MAX_UNTRACKED_PREVIEW_FILES)) {
    fileSet.add(rel)
  }

  const statParts: string[] = []
  if (stagedStat?.trim()) statParts.push(`Staged:\n${stagedStat.trim()}`)
  if (unstagedStat?.trim()) statParts.push(`Unstaged:\n${unstagedStat.trim()}`)
  const diffStat = statParts.join('\n\n')

  const diffParts: string[] = []
  if (stagedDiff?.trim()) diffParts.push(`=== Staged Diff ===\n${stagedDiff.trim()}`)
  if (unstagedDiff?.trim()) diffParts.push(`=== Unstaged Diff ===\n${unstagedDiff.trim()}`)
  if (untrackedSections.length > 0) {
    diffParts.push(`=== Untracked Files (preview) ===\n${untrackedSections.join('\n\n')}`)
  }

  const fullDiff = diffParts.join('\n\n')
  const diffHash = createHash('sha256')
    .update(statusShort)
    .update('\n')
    .update(fullDiff)
    .digest('hex')
    .slice(0, 16)

  let diffText = fullDiff
  let diffTruncated = false
  if (diffText.length > maxDiffChars) {
    diffTruncated = true
    diffText =
      diffText.slice(0, maxDiffChars) +
      `\n\n... [diff truncated: showing ${maxDiffChars} of ${fullDiff.length} chars]`
  }

  return {
    isGitRepo: true,
    branch,
    headSha,
    statusShort,
    diffStat,
    diffText,
    diffTruncated,
    added,
    removed,
    files: fileSet.size,
    changedLines: added + removed,
    diffHash
  }
}

export type WorkspaceFilesResult = {
  files: { path: string; content: string; truncated: boolean }[]
  included: string[]
  skipped: string[]
}

export async function readWorkspaceFiles(
  workspacePath: string,
  requestedPaths: string[],
  options?: {
    maxFileChars?: number
    maxTotalChars?: number
    redact?: boolean
  }
): Promise<WorkspaceFilesResult> {
  const maxFileChars = options?.maxFileChars ?? MAX_FILE_CHARS_DEFAULT
  const maxTotalChars = options?.maxTotalChars ?? MAX_TOTAL_FILES_CHARS_DEFAULT
  const redact = options?.redact ?? true

  const files: { path: string; content: string; truncated: boolean }[] = []
  const included: string[] = []
  const skipped: string[] = []

  if (!requestedPaths.length) {
    return { files, included, skipped }
  }

  let rootReal: string
  try {
    rootReal = await fs.realpath(workspacePath)
  } catch {
    return {
      files,
      included,
      skipped: requestedPaths.map((p) => `${p} (workspace inaccessible)`)
    }
  }

  let remainingChars = maxTotalChars
  const seen = new Set<string>()

  for (const rawPath of requestedPaths) {
    const trimmed = rawPath.trim()
    if (!trimmed) continue
    if (remainingChars <= 0) {
      skipped.push(`${trimmed} (total character budget reached)`)
      continue
    }

    const candidateResolved = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : path.resolve(rootReal, trimmed)

    if (!isPathInside(rootReal, candidateResolved)) {
      skipped.push(`${trimmed} (outside workspace)`)
      continue
    }

    const relPosix = path.relative(rootReal, candidateResolved).replace(/\\/g, '/')
    if (!relPosix || seen.has(relPosix)) continue
    seen.add(relPosix)

    if (isSensitiveRelativePath(relPosix)) {
      skipped.push(`${relPosix} (sensitive file skipped)`)
      continue
    }

    let candReal: string
    try {
      candReal = await fs.realpath(candidateResolved)
    } catch {
      skipped.push(`${relPosix} (not found)`)
      continue
    }

    if (!isPathInside(rootReal, candReal)) {
      skipped.push(`${relPosix} (symlink points outside workspace)`)
      continue
    }

    try {
      const stat = await fs.stat(candReal)
      if (!stat.isFile()) {
        skipped.push(`${relPosix} (not a regular file)`)
        continue
      }
      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        skipped.push(`${relPosix} (exceeds 512 KiB limit)`)
        continue
      }
      const buf = await fs.readFile(candReal)
      if (isBinaryBuffer(buf)) {
        skipped.push(`${relPosix} (binary file)`)
        continue
      }

      let content = buf.toString('utf8')
      if (redact) content = redactSecretPatterns(content)

      const cap = Math.min(maxFileChars, remainingChars)
      let truncated = false
      if (content.length > cap) {
        truncated = true
        content = content.slice(0, cap) + `\n... [truncated at ${cap} chars]`
      }

      remainingChars -= content.length
      files.push({ path: relPosix, content, truncated })
      included.push(relPosix)
    } catch {
      skipped.push(`${relPosix} (read error)`)
    }
  }

  return { files, included, skipped }
}

export type CollectedContext = {
  promptSection: string
  summary: ContextSummary
  diffHash: string
}

export async function collectConsultationContext(params: {
  workspacePath: string | null
  branchHint?: string | null
  files?: string[]
  includeDiff?: boolean
  maxDiffChars?: number
  terminalLines?: string[]
  redactSecrets?: boolean
}): Promise<CollectedContext> {
  const includeDiff = params.includeDiff ?? true
  const maxDiffChars = params.maxDiffChars ?? 24_000
  const redact = params.redactSecrets ?? true

  let diffStats: DiffStatsResult = {
    isGitRepo: false,
    branch: params.branchHint ?? null,
    headSha: null,
    statusShort: '',
    diffStat: '',
    diffText: '',
    diffTruncated: false,
    added: 0,
    removed: 0,
    files: 0,
    changedLines: 0,
    diffHash: 'none'
  }

  if (params.workspacePath && includeDiff) {
    diffStats = await computeDiffStats(params.workspacePath, maxDiffChars)
  } else if (params.workspacePath) {
    const [branchRaw, headRaw] = await Promise.all([
      runGit(params.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      runGit(params.workspacePath, ['rev-parse', '--short', 'HEAD'])
    ])
    diffStats.branch = branchRaw?.trim() || params.branchHint || null
    diffStats.headSha = headRaw?.trim() || null
  }

  const fileRes: WorkspaceFilesResult =
    params.workspacePath && params.files?.length
      ? await readWorkspaceFiles(params.workspacePath, params.files, { redact })
      : { files: [], included: [], skipped: [] }

  const rawTermLines = (params.terminalLines ?? []).slice(-120)
  let terminalText = stripAnsi(rawTermLines.join('\n')).trim()
  if (redact && terminalText) {
    terminalText = redactSecretPatterns(terminalText)
  }

  const sections: string[] = []
  sections.push(
    [
      '## Workspace Context',
      `- Path: ${params.workspacePath ?? '(none)'}`,
      `- Branch: ${diffStats.branch ?? params.branchHint ?? '(unknown)'}${diffStats.headSha ? ` @ ${diffStats.headSha}` : ''}`,
      includeDiff
        ? `- Diff summary: +${diffStats.added} / -${diffStats.removed} across ${diffStats.files} file(s)`
        : '- Diff attachment: disabled for this call'
    ].join('\n')
  )

  if (includeDiff && diffStats.statusShort) {
    const statusClean = redact ? redactSecretPatterns(diffStats.statusShort) : diffStats.statusShort
    sections.push(`## Git Status\n\`\`\`\n${statusClean}\n\`\`\``)
  }

  if (includeDiff && diffStats.diffText) {
    const diffClean = redact ? redactSecretPatterns(diffStats.diffText) : diffStats.diffText
    sections.push(`## Git Diff\n\`\`\`diff\n${diffClean}\n\`\`\``)
  } else if (includeDiff) {
    sections.push('## Git Diff\nNo uncommitted changes.')
  }

  if (fileRes.files.length > 0) {
    const blocks = fileRes.files.map(
      (f) => `### File: ${f.path}${f.truncated ? ' (truncated)' : ''}\n\`\`\`\n${f.content}\n\`\`\``
    )
    sections.push(`## Referenced Files\n${blocks.join('\n\n')}`)
  }

  if (fileRes.skipped.length > 0) {
    sections.push(`## Skipped Files\n- ${fileRes.skipped.join('\n- ')}`)
  }

  if (terminalText) {
    sections.push(`## Active Terminal Output (tail)\n\`\`\`\n${terminalText.slice(-12_000)}\n\`\`\``)
  }

  return {
    promptSection: sections.join('\n\n'),
    summary: {
      branch: diffStats.branch ?? params.branchHint ?? null,
      headSha: diffStats.headSha,
      diffAdded: diffStats.added,
      diffRemoved: diffStats.removed,
      diffFiles: diffStats.files,
      diffTruncated: diffStats.diffTruncated,
      filesIncluded: fileRes.included,
      filesSkipped: fileRes.skipped,
      terminalLines: rawTermLines.length
    },
    diffHash: diffStats.diffHash
  }
}
