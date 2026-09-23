import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { Config, DEFAULT_ROOT, apply, resolveCommitVersion, VERSION_ROUTE_PATH } from '../src/index.ts'

/** Minimal webServer face capturing what a plugin registers. */
function fakeWebServer(): { server: WebServer; routes: () => unknown[] } {
  const routes: unknown[] = []
  const server = {
    host: '127.0.0.1',
    port: 4567,
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
    register: (route: unknown) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  } as unknown as WebServer
  return { server, routes: () => routes }
}

/** Drive one registered route handler and report what it wrote. */
function callRoute(route: unknown): { statusCode: number; headers: Record<string, string>; body: string } {
  const captured = route as {
    handler: (req: unknown, res: {
      writeHead: (code: number, headers: Record<string, string>) => void
      end: (body: string) => void
    }) => void
  }
  let statusCode = 0
  let headers: Record<string, string> = {}
  let body = ''
  captured.handler({}, {
    writeHead: (code, h) => { statusCode = code; headers = h },
    end: (chunk) => { body = chunk },
  })
  return { statusCode, headers, body }
}

describe('version-route', () => {
  it('registers /version answering with the commit snapshot taken when it applied', async () => {
    const ctx = new Context()
    const { server, routes } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({}))
    await new Promise(resolve => setTimeout(resolve, 0))

    const route = routes().find(entry => (entry as { path: string }).path === VERSION_ROUTE_PATH)
    expect(route).toBeDefined()
    expect((route as { kind: string }).kind).toBe('exact')

    const { statusCode, headers, body } = callRoute(route)
    expect(statusCode).toBe(200)
    expect(headers['content-type']).toBe('application/json')
    const payload = JSON.parse(body) as { commit: string; short: string; dirty: boolean }
    if (payload.commit === 'unknown') {
      expect(payload.short).toBe('unknown')
      expect(payload.dirty).toBe(false)
    } else {
      expect(payload.commit).toMatch(/^[0-9a-f]{40}$/)
      expect(payload.short).toBe(payload.commit.slice(0, 7))
      expect(typeof payload.dirty).toBe('boolean')
    }
    await ctx.fiber.dispose()
  })

  it('withdraws the route when the fiber that mounted it is disposed', async () => {
    const ctx = new Context()
    const { server, routes } = fakeWebServer()
    ctx.provide('webServer', server)
    apply(ctx, new Config({}))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(routes()).toHaveLength(1)

    await ctx.fiber.dispose()
    expect(routes()).toHaveLength(0)
  })

  it('reports every field as unknown for a directory that is not a git checkout', () => {
    // A packed or vendored install: `git -C` fails, and the answer stays
    // serializable rather than propagating the spawn failure into the route.
    expect(resolveCommitVersion(join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-checkout'))).toEqual({
      commit: 'unknown',
      short: 'unknown',
      dirty: false,
    })
  })

  it('defaults the root to the checkout this package was loaded from', () => {
    expect(new Config({}).root).toBe(DEFAULT_ROOT)
  })
})
