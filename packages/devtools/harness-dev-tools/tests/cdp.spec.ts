/** The DevTools client: target choice, key events, and one command round trip. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { CdpConnection, CdpError, keyPress, listTargets, selectTarget, type CdpTarget } from '../src/cdp.ts'

const page = (url: string, title = '', type = 'page'): CdpTarget => ({ id: url, type, url, title, webSocketDebuggerUrl: `ws://x/${url}` })

describe('selectTarget', () => {
  const targets = [page('devtools://x'), page('about:blank'), page('dsh-app://app/', 'Harness'), page('https://example.com/', 'Example', 'webview')]

  it('defaults to the application window, skipping DevTools and blank pages', () => {
    expect(selectTarget(targets).url).toBe('dsh-app://app/')
  })

  it('picks the first webview, or any target by address or title', () => {
    expect(selectTarget(targets, 'webview').url).toBe('https://example.com/')
    expect(selectTarget(targets, 'Example').url).toBe('https://example.com/')
  })

  it('names the known targets when nothing matches', () => {
    expect(() => selectTarget(targets, 'nope')).toThrow(/no target matches "nope".*webview https:\/\/example.com/)
  })
})

describe('keyPress', () => {
  it('presses Enter with the carriage return a form submits on', () => {
    expect(keyPress('Enter')).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    ])
  })

  it('types a character key and sends Escape without text', () => {
    expect(keyPress('a')[0]).toMatchObject({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(keyPress('Escape')[0]).not.toHaveProperty('text')
  })
})

describe('the protocol endpoint', () => {
  const closers: (() => Promise<void>)[] = []
  afterEach(async () => { for (const close of closers.splice(0)) await close() })

  async function endpoint(): Promise<{ port: number; sockets: WebSocketServer }> {
    const http: Server = createServer()
    const sockets = new WebSocketServer({ server: http })
    await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve) })
    const { port } = http.address() as AddressInfo
    http.on('request', (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([{ id: '1', type: 'page', url: 'dsh-app://app/', title: 'H', webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/1` }, { junk: true }]))
    })
    sockets.on('connection', (socket) => {
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString('utf8')) as { id: number; method: string }
        if (message.method === 'Emit.event') socket.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }))
        if (message.method === 'Emit.bare') socket.send(JSON.stringify({ method: 'Page.frame' }))
        if (message.method === 'Fail.now') socket.send(JSON.stringify({ id: message.id, error: { message: 'no such method' } }))
        else socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }))
      })
    })
    closers.push(async () => {
      for (const client of sockets.clients) client.terminate()
      await new Promise<void>((resolve) => { sockets.close(() => { resolve() }) })
      await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
    })
    return { port, sockets }
  }

  it('lists targets, dropping entries that are not targets', async () => {
    const { port } = await endpoint()
    const targets = await listTargets(port)
    expect(targets.map(target => target.url)).toEqual(['dsh-app://app/'])
  })

  it('sends a command and returns its result, or its protocol error', async () => {
    const { port } = await endpoint()
    const [target] = await listTargets(port)
    if (target === undefined) throw new Error('no target')
    const connection = await CdpConnection.open(target, 5000)
    expect(await connection.send('Runtime.evaluate')).toEqual({ echoed: 'Runtime.evaluate' })
    await expect(connection.send('Fail.now')).rejects.toThrow('no such method')
    connection.close()
  })

  it('delivers protocol events to listeners until they stop listening', async () => {
    const { port } = await endpoint()
    const [target] = await listTargets(port)
    if (target === undefined) throw new Error('no target')
    const connection = await CdpConnection.open(target, 5000)
    const seen: string[] = []
    const off = connection.onEvent((method, params) => { seen.push(`${method}:${JSON.stringify(params)}`) })
    await connection.send('Emit.event')
    await connection.send('Emit.bare')
    off()
    await connection.send('Emit.event')
    expect(seen).toEqual(['Runtime.consoleAPICalled:{"type":"log"}', 'Page.frame:{}'])
    connection.close()
  })

  it('reports a port nothing listens on', async () => {
    await expect(listTargets(1)).rejects.toBeInstanceOf(CdpError)
  })
})
