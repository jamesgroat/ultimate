import { spawn } from '../../lib/spawn.ts'

const MAX_AUDIO_BYTES = 24000 * 2 * 60

/** Text on stdin, headerless PCM16 LE mono at 24 kHz on stdout; diagnostics belong on stderr. */
export function speakCommand(command: string[], text: string, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1))
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    const fail = (error: Error) => {
      reject(error)
      child.kill('SIGKILL')
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const abort = () => fail(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_AUDIO_BYTES)
        return fail(new Error('Narrator command audio exceeds 60 seconds'))
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(0, 4096)
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (code !== 0)
        return reject(
          new Error(`Narrator command exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`),
        )
      const pcm = Buffer.concat(chunks)
      if (!pcm.length || pcm.length % 2)
        return reject(new Error('Narrator command must return nonempty PCM16'))
      resolve(pcm)
    })
    if (signal.aborted) abort()
    else child.stdin.end(text)
  })
}
