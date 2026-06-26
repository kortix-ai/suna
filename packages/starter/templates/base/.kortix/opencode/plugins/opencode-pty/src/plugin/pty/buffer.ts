// Default buffer size in characters (approximately 1MB)
const DEFAULT_MAX_BUFFER_SIZE = parseInt(process.env.PTY_MAX_BUFFER_SIZE || '1000000', 10)

export interface SearchMatch {
  lineNumber: number
  text: string
}

export class RingBuffer {
  private buffer: string = ''
  private maxSize: number

  constructor(maxSize: number = DEFAULT_MAX_BUFFER_SIZE) {
    this.maxSize = maxSize
  }

  append(data: string): void {
    this.buffer += data
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize)
    }
  }

  private splitBufferLines(): string[] {
    const lines: string[] = this.buffer.split('\n')
    // Remove empty string at end if buffer doesn't end with newline
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop()
    }
    return lines
  }

  read(offset: number = 0, limit?: number): string[] {
    if (this.buffer === '') return []
    const lines: string[] = this.splitBufferLines()
    const start = Math.max(0, offset)
    const end = limit !== undefined ? start + limit : lines.length
    return lines.slice(start, end)
  }

  readRaw(): string {
    return this.buffer
  }

  search(pattern: RegExp): SearchMatch[] {
    const matches: SearchMatch[] = []
    const lines: string[] = this.splitBufferLines()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line && pattern.test(line)) {
        matches.push({ lineNumber: i + 1, text: line })
      }
    }
    return matches
  }

  get length(): number {
    if (this.buffer === '') return 0
    const lines = this.splitBufferLines()
    return lines.length
  }

  get byteLength(): number {
    return this.buffer.length
  }

  flush(): void {
    // No-op in new implementation
  }

  clear(): void {
    this.buffer = ''
  }
}
