import { assert, describe, test } from 'orca/testing'
import { LoopTracker, parseAdvisorVerdict, TurnTracker } from './guards'

describe('guards', () => {
  test('LoopTracker ignores repeated clean read-only calls', () => {
    const tracker = new LoopTracker()
    for (let i = 0; i < 5; i++) {
      const res = tracker.recordToolAfter(
        {
          agent: 'claude',
          workspaceId: 'ws1',
          terminalId: 't1',
          tool: 'Read',
          input: { file_path: 'src/index.ts' },
          output: 'const a = 1'
        },
        3
      )
      assert.equal(res.alert, null)
      assert.equal(res.newlyTriggered, false)
    }
  })

  test('LoopTracker triggers on repeated mutating/bash calls at threshold and resets on clean different call', () => {
    const tracker = new LoopTracker()
    const event = {
      agent: 'claude',
      workspaceId: 'ws1',
      terminalId: 't1',
      tool: 'Bash',
      input: { command: 'npm test' },
      output: 'Error: test failed'
    }

    assert.equal(tracker.recordToolAfter(event, 3).alert, null)
    assert.equal(tracker.recordToolAfter(event, 3).alert, null)
    const third = tracker.recordToolAfter(event, 3)
    assert.ok(third.alert)
    assert.equal(third.newlyTriggered, true)
    assert.equal(third.alert?.count, 3)
    assert.equal(third.alert?.tool, 'Bash')

    const cleanDiff = tracker.recordToolAfter(
      {
        agent: 'claude',
        workspaceId: 'ws1',
        terminalId: 't1',
        tool: 'Edit',
        input: { file_path: 'src/app.ts' },
        output: 'ok'
      },
      3
    )
    assert.equal(cleanDiff.alert, null)
  })

  test('TurnTracker fires turn_started and turn_finished once per transition', () => {
    const turns = new TurnTracker()
    assert.equal(
      turns.onStatusChanged({
        workspaceId: 'ws1',
        paneKey: 'p1',
        terminalId: 't1',
        state: 'done',
        receivedAt: 1
      }),
      'none'
    )
    assert.equal(
      turns.onStatusChanged({
        workspaceId: 'ws1',
        paneKey: 'p1',
        terminalId: 't1',
        state: 'working',
        receivedAt: 2
      }),
      'turn_started'
    )
    assert.equal(
      turns.onStatusChanged({
        workspaceId: 'ws1',
        paneKey: 'p1',
        terminalId: 't1',
        state: 'working',
        receivedAt: 3
      }),
      'none'
    )
    assert.equal(
      turns.onStatusChanged({
        workspaceId: 'ws1',
        paneKey: 'p1',
        terminalId: 't1',
        state: 'done',
        receivedAt: 4
      }),
      'turn_finished'
    )
    assert.equal(
      turns.onStatusChanged({
        workspaceId: 'ws1',
        paneKey: 'p1',
        terminalId: 't1',
        state: 'waiting',
        receivedAt: 5
      }),
      'none'
    )
  })

  test('parseAdvisorVerdict detects LGTM vs CHANGES_REQUESTED', () => {
    assert.equal(parseAdvisorVerdict('VERDICT: LGTM\nEverything looks solid.'), 'LGTM')
    assert.equal(parseAdvisorVerdict('**LGTM** - clean diff.'), 'LGTM')
    assert.equal(
      parseAdvisorVerdict('VERDICT: CHANGES_REQUESTED\n1. Fix null check.'),
      'CHANGES_REQUESTED'
    )
    assert.equal(parseAdvisorVerdict('1. Missing error handling in worker.ts'), 'CHANGES_REQUESTED')
  })
})
