import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { assert, describe, test } from 'orca/testing'
import {
  collectConsultationContext,
  computeDiffStats,
  isSensitiveRelativePath,
  readWorkspaceFiles,
  redactSecretPatterns,
  stripAnsi
} from './context'

const execFileAsync = promisify(execFile)

describe('context helpers', () => {
  test('strips ANSI sequences and normalizes newlines', () => {
    const raw = '\x1b[31mError:\x1b[0m failed\r\n\x1b]0;Title\x07next line'
    assert.equal(stripAnsi(raw), 'Error: failed\nnext line')
  })

  test('redacts common API keys and bearer tokens', () => {
    const input = [
      'ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890',
      'OPENROUTER=sk-or-v1-1234567890abcdef1234',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'token="super_secret_token_12345"'
    ].join('\n')

    const clean = redactSecretPatterns(input)
    assert.equal(clean.includes('abcdef1234567890'), false)
    assert.equal(clean.includes('1234567890abcdef1234'), false)
    assert.equal(clean.includes('eyJhbGciOiJIUzI1NiIs'), false)
    assert.equal(clean.includes('super_secret_token_12345'), false)
    assert.match(clean, /\[REDACTED/)
  })

  test('flags sensitive filenames while allowing env examples', () => {
    assert.equal(isSensitiveRelativePath('.env'), true)
    assert.equal(isSensitiveRelativePath('config/.env.production'), true)
    assert.equal(isSensitiveRelativePath('.env.example'), false)
    assert.equal(isSensitiveRelativePath('keys/server.pem'), true)
    assert.equal(isSensitiveRelativePath('src/index.ts'), false)
  })

  test('readWorkspaceFiles prevents traversal, skips sensitive and binary files, and truncates safely', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-ctx-'))
    const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.txt`)
    try {
      await fs.writeFile(outsideFile, 'secret outside', 'utf8')
      await fs.mkdir(path.join(dir, 'src'), { recursive: true })
      await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export const x = "sk-ant-1234567890abcdef"\n', 'utf8')
      await fs.writeFile(path.join(dir, '.env'), 'SECRET=123456789\n', 'utf8')
      await fs.writeFile(path.join(dir, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]))

      const res = await readWorkspaceFiles(
        dir,
        ['src/app.ts', '../' + path.basename(outsideFile), '.env', 'bin.dat', 'missing.ts'],
        { redact: true }
      )

      assert.deepEqual(res.included, ['src/app.ts'])
      assert.equal(res.files.length, 1)
      assert.match(res.files[0].content, /\[REDACTED_ANTHROPIC_KEY\]/)
      assert.equal(res.skipped.length, 4)
      assert.ok(res.skipped.some((s) => s.includes('outside workspace')))
      assert.ok(res.skipped.some((s) => s.includes('sensitive file')))
      assert.ok(res.skipped.some((s) => s.includes('binary file')))
      assert.ok(res.skipped.some((s) => s.includes('not found')))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(outsideFile, { force: true })
    }
  })

  test('computeDiffStats and collectConsultationContext capture git diffs and untracked files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-git-'))
    try {
      await execFileAsync('git', ['init'], { cwd: dir })
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      await execFileAsync('git', ['config', 'user.name', 'Tester'], { cwd: dir })
      await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
      await execFileAsync('git', ['add', 'a.ts'], { cwd: dir })
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: dir })

      await fs.writeFile(path.join(dir, 'a.ts'), 'export const a = 2\nexport const b = 3\n', 'utf8')
      await fs.writeFile(path.join(dir, 'newfile.ts'), 'export const c = 4\n', 'utf8')

      const stats = await computeDiffStats(dir, 100)
      assert.equal(stats.isGitRepo, true)
      assert.ok(stats.changedLines >= 3)
      assert.ok(stats.files >= 2)
      assert.equal(stats.diffTruncated, true)
      assert.ok(stats.diffHash.length === 16)

      const collected = await collectConsultationContext({
        workspacePath: dir,
        files: ['a.ts'],
        includeDiff: true,
        terminalLines: ['\x1b[32mPASS\x1b[0m', 'API_KEY=abcdefgh12345'],
        redactSecrets: true
      })

      assert.deepEqual(collected.summary.filesIncluded, ['a.ts'])
      assert.equal(collected.summary.terminalLines, 2)
      assert.match(collected.promptSection, /## Git Diff/)
      assert.match(collected.promptSection, /## Active Terminal Output/)
      assert.equal(collected.promptSection.includes('abcdefgh12345'), false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
