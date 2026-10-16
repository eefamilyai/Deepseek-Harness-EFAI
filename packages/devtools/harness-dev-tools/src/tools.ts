/**
 * The two model-facing tools: `desktop_test_instance` and `build_workspace_package`.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { BUILD_STEPS, buildWorkspacePackage, findWorkspaceRoot, resolveWorkspacePackage } from './build-package.ts'
import type { DesktopTestInstance, InstanceScreenshot } from './desktop-instance.ts'

/** The actions `desktop_test_instance` accepts. */
export const INSTANCE_ACTIONS = ['launch', 'stop', 'status', 'prepare', 'targets', 'eval', 'wait', 'screenshot', 'click', 'type', 'key', 'reload', 'log'] as const

/** Cut text to a cap, keeping the head. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${String(text.length - max)} characters truncated]`
}

/** The committed-image fields a screenshot result carries, as the `browser` tool declares them. */
const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/** The structured value a `desktop_test_instance` call returns. */
interface InstanceValue {
  text: string
  image?: { attachmentId: string; mediaType: ImageMediaType; bytes: number; width: number; height: number; name?: string }
}

/**
 * Attach a screenshot as an image the caller can look at, when the calling route accepts
 * images and an attachment store is mounted; otherwise the saved file path is the result.
 */
async function attachScreenshot(ctx: Context, exec: ToolExecution, shot: InstanceScreenshot): Promise<InstanceValue> {
  const text = `Screenshot of ${shot.target}, saved to ${shot.path}`
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (attachments === undefined || llm === undefined || provider === undefined || model === undefined) {
    return { text: `${text}. No image is attached: this composition has no attachment store or no resolvable model route.` }
  }
  const info = await llm.resolveModelInfo(provider, model, exec.signal)
  if (info.inputModalities?.includes('image') !== true) {
    return { text: `${text}. No image is attached: model "${model}" does not declare image input.` }
  }
  const ref = await attachments.saveImage({ data: shot.data, mediaType: 'image/png', name: 'desktop-test-instance.png' })
  return {
    text,
    image: {
      attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
      ...ref.name === undefined ? {} : { name: ref.name },
    },
  }
}

/**
 * Build the `desktop_test_instance` tool.
 * @param ctx - resolves the optional `attachments` and `llm` services for screenshots.
 * @param instance - the resolved test instance.
 * @param maxOutputChars - cap on one result's text.
 * @returns the tool definition.
 */
export function desktopTestInstanceTool(ctx: Context, instance: () => DesktopTestInstance, maxOutputChars: number): ToolDefinition {
  return defineTool({
    name: 'desktop_test_instance',
    description: 'Start, drive, and stop a separate test copy of the installed DeepSeek Harness Desktop app.'
      + ' Use it to check a GUI change in a real Desktop window without restarting the one the user is working in. The copy runs on its own'
      + ' profile (cloned from the user\'s, without sessions) and is driven over the Chrome DevTools Protocol. Actions:'
      + ' launch (copy if stale, start, wait for the window; also restarts a running copy, which reloads rebuilt plugins),'
      + ' stop, status, prepare (copy and clone only), targets (list windows and embedded webviews), eval (run JavaScript'
      + ' in the window, returns its JSON value), wait (poll an expression until truthy), screenshot (returns the image'
      + ' and saves a PNG), click (x, y in CSS pixels), type (insert text into the focused element), key (press a key such'
      + ' as Enter or Escape), reload, log (the window console and process output). `target` picks a webview ("webview")'
      + ' or any target whose address or title contains the text; the default is the app window.',
    parameters: {
      action: { type: 'string', required: true, enum: [...INSTANCE_ACTIONS], description: `One of: ${INSTANCE_ACTIONS.join(', ')}.` },
      expression: { type: 'string', description: 'For eval and wait: the JavaScript expression; a promise is awaited.' },
      target: { type: 'string', description: 'Which target to drive: empty for the app window, "webview" for the first embedded webview, or text its address or title contains.' },
      x: { type: 'number', description: 'For click: CSS pixels from the left edge of the target viewport.' },
      y: { type: 'number', description: 'For click: CSS pixels from the top edge of the target viewport.' },
      text: { type: 'string', description: 'For type: the text to insert.' },
      key: { type: 'string', description: 'For key: a key name such as Enter, Escape, Tab, ArrowDown, or a single character.' },
      timeoutMs: { type: 'integer', description: 'For wait: how long to poll, in milliseconds (default 15000). For eval: how long the expression may run (default commandTimeoutMs, 30000).' },
      lines: { type: 'integer', description: 'For status and log: how many log lines to return (default 20 for status, 60 for log).' },
      fresh: { type: 'boolean', description: 'For launch and prepare: recopy the app and reclone the profile even when they are current.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true }, image: IMAGE_SCHEMA },
      },
      render: (_args, value) => {
        const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
        if (value.image !== undefined) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(value.image.attachmentId), mediaType: value.image.mediaType,
              bytes: value.image.bytes, width: value.image.width, height: value.image.height,
              ...value.image.name === undefined ? {} : { name: value.image.name },
            },
          })
        }
        return blocks
      },
    },
    async execute(args, exec): Promise<InstanceValue> {
      const desktop = instance()
      const out = (text: string): InstanceValue => ({ text: cap(text, maxOutputChars) })
      const need = <T>(value: T | undefined, what: string): T => {
        if (value === undefined) throw new Error(`${args.action} needs ${what}`)
        return value
      }
      switch (args.action) {
        case 'launch': return out(await desktop.launch(args.fresh === true))
        case 'stop': return out((await desktop.stop()) ? 'stopped the test instance' : 'the test instance was not running')
        case 'prepare': return out(await desktop.prepare(args.fresh === true))
        case 'status': return out(JSON.stringify(await desktop.status(args.lines ?? 20), null, 1))
        case 'targets': return out(JSON.stringify((await desktop.status(0)).targets, null, 1))
        case 'log': return out(desktop.logTail(args.lines ?? 60) || '(the log is empty)')
        case 'eval': return out(await desktop.evaluate(need(args.expression, 'an "expression"'), args.target, args.timeoutMs))
        case 'wait': return out(await desktop.waitFor(need(args.expression, 'an "expression"'), args.timeoutMs ?? 15_000, args.target))
        case 'screenshot': return attachScreenshot(ctx, exec, await desktop.screenshot(args.target))
        case 'click': return out(`clicked (${String(need(args.x, '"x"'))}, ${String(need(args.y, '"y"'))}) on ${await desktop.click(args.x ?? 0, args.y ?? 0, args.target)}`)
        case 'type': await desktop.type(need(args.text, '"text"'), args.target); return out('typed')
        case 'key': await desktop.key(need(args.key, 'a "key"'), args.target); return out(`pressed ${args.key ?? ''}`)
        case 'reload': await desktop.reload(args.target); return out('reloaded; a rebuilt plugin bundle needs action "launch" instead, which restarts the copy')
      }
    },
  })
}

/** Inputs the build tool resolves once. */
export interface BuildToolOptions {
  /** A configured workspace root, or empty to find it above the Session's working directory or this package. */
  readonly repoRoot: string | (() => string)
  /** Where this package's code really lives (a junctioned install resolves to the checkout); its workspace is the last fallback. */
  readonly installDir?: string | undefined
  /** The executable that runs Node scripts. */
  readonly nodeExecutable: string
  /** Where generated build configs are written. */
  readonly scratchDir: string
  /** Characters of output kept per step. */
  readonly stepOutputChars: number
}

/**
 * The workspace a build runs in: the call's own root, then the configured one,
 * then the workspace above the Session's working directory, then the checkout
 * this package was loaded from. A Session working outside the checkout (the
 * usual case) still builds the checkout the harness runs from.
 * @param explicit - the call's `root` argument.
 * @param configured - the plugin's `repoRoot`.
 * @param cwd - the Session's working directory.
 * @param installDir - where this package really lives.
 * @returns the workspace root.
 */
export function buildRoot(explicit: string | undefined, configured: string, cwd: string, installDir: string | undefined): string {
  for (const candidate of [explicit, configured]) {
    if (candidate === undefined || candidate === '') continue
    const root = findWorkspaceRoot(candidate)
    if (root === undefined) throw new Error(`${candidate} is not inside a DeepSeek Harness workspace (no pnpm-workspace.yaml and tsconfig.host.json above it)`)
    return root
  }
  const root = findWorkspaceRoot(cwd) ?? (installDir === undefined ? undefined : findWorkspaceRoot(installDir))
  if (root === undefined) throw new Error(`no DeepSeek Harness workspace above ${cwd}; pass root, or set repoRoot in the plugin config`)
  return root
}

/**
 * Build the `build_workspace_package` tool.
 * @param options - root, Node executable, scratch directory, and output cap.
 * @returns the tool definition.
 */
export function buildWorkspacePackageTool(options: BuildToolOptions): ToolDefinition {
  return defineTool({
    name: 'build_workspace_package',
    description: 'Build ONE package of the DeepSeek Harness workspace without running the whole root build.'
      + ' It runs the same steps the root build would: typecheck (tsc -b over its tsconfig.json), typert (generate its Typert and Remote artifacts when'
      + ' it exports ./typert, ./client/typert, or ./remote), and bundle (its own tsdown.config.ts, which Client packages'
      + ' have, otherwise the root Host bundle pass). A package that generates Typert artifacts is typed Host face first,'
      + ' then again after generation. Name the package by directory (packages/web/web-browser) or by name'
      + ' (@deepseek-ai/dsh-web-browser, or just web-browser). Returns each step with its output; the first failing step'
      + ' stops the rest. A running Host or window loads the rebuilt output only after it restarts or reloads.',
    parameters: {
      package: { type: 'string', required: true, description: 'The package directory, relative to the workspace root or absolute, or its package name.' },
      root: { type: 'string', description: 'The workspace root to build in. Default: the configured root, else the workspace above the Session working directory, else the checkout this harness runs from.' },
      steps: { type: 'array', items: { type: 'string', enum: [...BUILD_STEPS] }, description: 'The steps to run (default all): typecheck, typert, bundle.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const root = buildRoot(args.root, typeof options.repoRoot === 'function' ? options.repoRoot() : options.repoRoot, cwd, options.installDir)
      const pkg = resolveWorkspacePackage(root, args.package)
      const results = await buildWorkspacePackage(pkg, {
        root,
        nodeExecutable: options.nodeExecutable,
        scratchDir: options.scratchDir,
        outputChars: options.stepOutputChars,
        signal: exec.signal,
        ...args.steps === undefined ? {} : { steps: args.steps },
      })
      const ok = results.every(result => result.ok)
      const lines = [`${ok ? 'built' : 'FAILED'} ${pkg.name} (${pkg.dir})`]
      for (const result of results) {
        if (result.skipped !== undefined) { lines.push(`- ${result.step}: skipped, ${result.skipped}`); continue }
        lines.push(`- ${result.step}: ${result.ok ? 'ok' : 'failed'} in ${String(Math.round(result.ms / 100) / 10)} s`)
        if (result.output !== '' && (!result.ok || result.step !== 'typecheck')) lines.push(result.output.split('\n').map(line => `    ${line}`).join('\n'))
      }
      return { text: lines.join('\n'), ok }
    },
  })
}
