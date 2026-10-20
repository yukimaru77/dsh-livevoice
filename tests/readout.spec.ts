import { describe, expect, it } from 'vitest'
import { buildReadoutMessages } from '../src/readout.ts'

describe('complete backend readout', () => {
  it('stages every byte before the speakable trigger, including questions and code', () => {
    const text = '意味はこうです。\n' + 'この説明を省略しません。'.repeat(100)
      + '\n1. 観測します。\n2. 判断します。\n3. 実行します。\nA、B のどちらですか？\n```sh\nnpm test\n```'
    const messages = buildReadoutMessages(text, 'readout-123')
    const scripts = messages.slice(0, -1)
    expect(scripts.every(m => m.type === 'session.context.append' && m.channel === 'commentary')).toBe(true)
    const contents = scripts.flatMap(m => 'content' in m ? m.content.map(c => c.text) : [])
    expect(contents.join('')).toBe(`<read_aloud id="readout-123">\n${text}\n</read_aloud>`)
    expect(contents.every(s => Buffer.byteLength(s, 'utf8') <= 500)).toBe(true)
    expect(messages.at(-1)).toMatchObject({
      type: 'session.context.append', channel: 'speakable',
      content: [{ type: 'input_text', text: expect.stringContaining('readout-123') }],
    })
  })
})
