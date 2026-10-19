import { describe, expect, it } from 'vitest'
import {
  briefLiveDelegation,
  parseTranscript,
  renderTranscript,
  renderWorkerHandoff,
  type RealtimeDelegation,
} from '../src/handoff.ts'

const brief: RealtimeDelegation = {
  input: 'Build a retro horse-running demo in the current repo.',
  transcriptDelta: [
    { role: 'user', text: '我想要那种复古的死磕编码的感觉' },
    { role: 'assistant', text: '好，我帮你开一个方向。' },
    { role: 'user', text: '一匹马在跑' },
  ],
}

describe('renderTranscript', () => {
  it('renders context lines plain, oldest first, with the current input as the final user line', () => {
    expect(renderTranscript(brief)).toBe(
      [
        'user: 我想要那种复古的死磕编码的感觉',
        'assistant: 好，我帮你开一个方向。',
        'user: 一匹马在跑',
        'user: Build a retro horse-running demo in the current repo.',
      ].join('\n'),
    )
  })

  it('returns undefined for empty or whitespace-only input', () => {
    expect(renderTranscript({ input: '', transcriptDelta: [] })).toBeUndefined()
    expect(renderTranscript({ input: '   \n', transcriptDelta: brief.transcriptDelta })).toBeUndefined()
  })

  it('does not escape special characters and flattens embedded newlines', () => {
    const rendered = renderTranscript({
      input: 'Use <script> & "quotes" and \'apos\'\nacross lines',
      transcriptDelta: [{ role: 'user', text: 'a < b & c' }],
    })
    expect(rendered).toContain('user: a < b & c')
    expect(rendered).toContain('user: Use <script> & "quotes" and \'apos\' across lines')
  })
})

describe('parseTranscript', () => {
  it('roundtrips a brief and mixed-role transcript', () => {
    const rendered = renderTranscript(brief)
    expect(rendered).toBeTypeOf('string')
    expect(parseTranscript(rendered ?? '')).toEqual(brief)
  })

  it('returns undefined for empty text or text without a trailing user line', () => {
    expect(parseTranscript('')).toBeUndefined()
    expect(parseTranscript('assistant: hello')).toBeUndefined()
    expect(parseTranscript('user:   ')).toBeUndefined()
    expect(parseTranscript('这个demo,我应该把,随便做点啥好看的就行')).toBeUndefined()
  })

  it('trims surrounding whitespace before parsing', () => {
    const rendered = renderTranscript({ input: 'Run the tests', transcriptDelta: [] })
    expect(parseTranscript(`\n${rendered}\n`)).toEqual({
      input: 'Run the tests',
      transcriptDelta: [],
    })
  })
})

describe('renderWorkerHandoff', () => {
  it('is exactly the plain transcript, with no preface, legend, or framing text', () => {
    const rendered = renderWorkerHandoff(brief)
    expect(rendered).toBe(renderTranscript(brief))
    expect(rendered).toMatch(/^(?:user|assistant): /)
    for (const banned of ['Live voice', 'handoff', 'worker', 'Codex', 'delegation', 'transcript', 'spoken conversation', '<']) {
      expect(rendered?.toLowerCase()).not.toContain(banned.toLowerCase())
    }
    expect(renderWorkerHandoff({ input: '  ', transcriptDelta: [] })).toBeUndefined()
  })

  it('contains only user:/assistant: lines, oldest context first then the current request last', () => {
    const rendered = renderWorkerHandoff(brief)
    expect(rendered).toBe(
      [
        'user: 我想要那种复古的死磕编码的感觉',
        'assistant: 好，我帮你开一个方向。',
        'user: 一匹马在跑',
        'user: Build a retro horse-running demo in the current repo.',
      ].join('\n'),
    )
  })
})

describe('briefLiveDelegation', () => {
  const oral = '就是我们在做的这个。东西啊,那个- 这个产品啊,这个页面。你让那个agent继续搞吗'

  it('preserves a complete colloquial question instead of regex-rewriting its meaning', () => {
    const input = briefLiveDelegation({ liveText: oral, lastUserSpeech: oral })
    expect(input).toBe(oral)
  })

  it('drops only provably pure greetings', () => {
    expect(briefLiveDelegation({ liveText: 'Hi' })).toBeUndefined()
    expect(briefLiveDelegation({ liveText: '您好！' })).toBeUndefined()
    expect(briefLiveDelegation({ liveText: '你好，看看当前任务进度' })).toBe('你好，看看当前任务进度')
  })

  it('passes through an already-clean imperative brief', () => {
    const clean = 'Build a jittery Y2K-coded horse-running demo in the current workspace.'
    expect(briefLiveDelegation({ liveText: clean })).toBe(clean)
  })

  it('keeps a fragment intact so recent transcript can resolve it downstream', () => {
    expect(briefLiveDelegation({ liveText: '就按刚才第二个方案' })).toBe('就按刚才第二个方案')
  })

  it('allows a read-only status request to reach the worker', () => {
    expect(briefLiveDelegation({
      liveText: '开工了吗?正在做吗?项目叫啥',
      lastUserSpeech: '开工了吗?正在做 吗?那个 项目 叫啥',
    })).toBe('开工了吗?正在做吗?项目叫啥')
  })

  it('keeps hypotheticals distinct from explicit change requests', () => {
    expect(briefLiveDelegation({ liveText: '假如让你优化会怎么做' })).toBe('假如让你优化会怎么做')
    expect(briefLiveDelegation({ liveText: '现在优化' })).toBe('现在优化')
  })

  it('puts the exact current request as the final line and recent speech earlier in context', () => {
    const input = briefLiveDelegation({ liveText: oral, lastUserSpeech: oral })
    if (input === undefined) throw new Error('expected a brief')
    const rendered = renderTranscript({
      input,
      transcriptDelta: [{ role: 'user', text: oral }],
    })
    const parsed = parseTranscript(rendered ?? '')
    expect(parsed?.input).toBe(input)
    expect(parsed?.input).toBe(oral)
    expect(parsed?.transcriptDelta).toEqual([{ role: 'user', text: oral }])
  })
})
