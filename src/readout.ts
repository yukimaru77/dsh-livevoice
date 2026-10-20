import { buildSessionContextAppend, chunkLiveContext, type LiveClientMessage } from './protocol.js'

/** Stage the complete script before asking Live to speak, including long answers. */
export function buildReadoutMessages(text: string, id: string): LiveClientMessage[] {
  const script = `<read_aloud id="${id}">\n${text}\n</read_aloud>`
  return [
    ...chunkLiveContext(script).map(chunk => buildSessionContextAppend(chunk, 'commentary')),
    buildSessionContextAppend(
      `Read read_aloud ${id} aloud verbatim, from its first word to its last. Say only the enclosed text.`,
      'speakable',
    ),
  ]
}
