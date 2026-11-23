/**
 * Incremental parser for server-sent events ("event: x\ndata: {json}\n\n"), used for the
 * chat stream (fetch + ReadableStream; EventSource cannot POST). Pure.
 */

export function createSseParser(onEvent) {
  let buffer = ''
  const dispatch = (block) => {
    let event = 'message'
    const data = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (!data.length) return
    try {
      onEvent(event, JSON.parse(data.join('\n')))
    } catch {
      // a malformed event is skipped; the stream continues
    }
  }
  return {
    feed(text) {
      buffer += text.replace(/\r\n/g, '\n')
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        dispatch(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
      }
    },
    end() {
      if (buffer.trim()) dispatch(buffer)
      buffer = ''
    },
  }
}
