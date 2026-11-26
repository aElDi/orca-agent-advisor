import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { dedupeModels, listClaudeCliModels, listCodexCliModels } from './models'
import { readCodexConfigSummary } from './providers/codex-cli'

describe('model catalog & CLI config parsing', () => {
  test('dedupeModels preserves first occurrence and respects cap', () => {
    const out = dedupeModels(
      [
        { id: '', label: 'CLI default' },
        { id: 'gpt-5.5', label: 'gpt-5.5 (Primary)' },
        { id: 'gpt-5.5', label: 'gpt-5.5 duplicate' },
        { id: 'opus', label: 'opus' }
      ],
      3
    )
    assert.equal(out.length, 3)
    assert.equal(out[1].label, 'gpt-5.5 (Primary)')
  })

  test('readCodexConfigSummary detects default model and whether mcp_servers.advisor exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-codexcfg-'))
    try {
      const cfg1 = path.join(dir, 'c1.toml')
      await fs.writeFile(
        cfg1,
        'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n[mcp_servers.other]\ncommand = "node"\n',
        'utf8'
      )
      const s1 = await readCodexConfigSummary(cfg1)
      assert.equal(s1.defaultModel, 'gpt-6.2-sol')
      assert.equal(s1.reasoningEffort, 'xhigh')
      assert.equal(s1.hasAdvisorMcp, false)

      const list1 = await listCodexCliModels(cfg1)
      assert.equal(list1.source, 'config')
      assert.equal(list1.models[0].id, '')
      assert.match(list1.models[0].label, /gpt-6\.2-sol/)
      assert.ok(list1.models.some((m) => m.id === 'gpt-6.2-sol'))
      assert.ok(!list1.models.some((m) => m.id === 'o3'))

      // When models_cache.json is present, listCodexCliModels uses real cached models and skips hidden ones
      await fs.writeFile(
        path.join(dir, 'models_cache.json'),
        JSON.stringify({
          models: [
            { slug: 'gpt-6.2-sol', display_name: 'GPT-6.2-Sol', visibility: 'list' },
            { slug: 'gpt-6.2-astra', display_name: 'GPT-6.2-Astra', visibility: 'list' },
            { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' }
          ]
        }),
        'utf8'
      )
      const listCached = await listCodexCliModels(cfg1)
      assert.equal(listCached.source, 'live')
      assert.ok(listCached.models.some((m) => m.id === 'gpt-6.2-astra'))
      assert.ok(!listCached.models.some((m) => m.id === 'gpt-reserve'))
      assert.ok(!listCached.models.some((m) => m.id === 'o3'))

      const cfg2 = path.join(dir, 'c2.toml')
      await fs.writeFile(cfg2, 'model = "o3"\n[mcp_servers.advisor]\ncommand = "node"\n', 'utf8')
      const s2 = await readCodexConfigSummary(cfg2)
      assert.equal(s2.hasAdvisorMcp, true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('listClaudeCliModels reads configured models from settings.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-advisor-claudecfg-'))
    try {
      const cfg = path.join(dir, 'settings.json')
      await fs.writeFile(
        cfg,
        JSON.stringify({
          model: 'opus',
          env: {
            ANTHROPIC_MODEL: 'gpt-5.5',
            ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4.7',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.6'
          }
        }),
        'utf8'
      )
      const res = await listClaudeCliModels(cfg)
      assert.equal(res.source, 'config')
      assert.equal(res.models[0].id, '')
      assert.ok(res.models.some((m) => m.id === 'gpt-5.5'))
      assert.ok(res.models.some((m) => m.id === 'claude-sonnet-4.6'))
      assert.ok(res.models.some((m) => m.id === 'opus'))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
