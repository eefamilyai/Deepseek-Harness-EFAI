/**
 * `@deepseek-ai/dsh-harness-dev-tools`: tools for changing the harness itself and
 * seeing the result.
 *
 * Registers two tools. `desktop_test_instance` starts a separate test copy of the
 * installed Desktop app on its own profile and drives its window over the Chrome
 * DevTools Protocol, so a GUI change can be checked in a real window while the
 * user keeps working in theirs. `build_workspace_package` builds one workspace
 * package — typecheck, Typert generation, bundle — without the whole root build.
 * Both are ordinary registered tools, so the Python kernel reaches them as
 * `desktop_test_instance(...)` and `build_workspace_package(...)` and `tool_help()`
 * lists them with their descriptions.
 *
 * @module @deepseek-ai/dsh-harness-dev-tools
 */

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import { DesktopTestInstance, desktopProfile, runningDesktop, type DesktopInstanceSpec } from './desktop-instance.ts'
import { buildWorkspacePackageTool, desktopTestInstanceTool } from './tools.ts'

export { DesktopTestInstance, desktopProfile, runningDesktop } from './desktop-instance.ts'
export type { DesktopInstanceSpec, InstanceScreenshot, InstanceStatus } from './desktop-instance.ts'
export { BUILD_STEPS, buildWorkspacePackage, findWorkspaceRoot, resolveWorkspacePackage } from './build-package.ts'
export type { BuildOptions, BuildStep, StepResult, WorkspacePackage } from './build-package.ts'
export { buildWorkspacePackageTool, desktopTestInstanceTool, INSTANCE_ACTIONS } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'harness-dev-tools'

/** `attachments` and `llm` are resolved per screenshot, so a composition without them keeps every other action. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** The installed Desktop app directory; empty means the one this Host runs inside. */
  desktopDir: string
  /** The Desktop executable's file name; empty means the one this Host runs as. */
  desktopExecutable: string
  /** Where the copy, its record, its log, and screenshots live; empty means `<dsh home>/desktop-test-instance`. */
  stateDir: string
  /** The profile the test profile is cloned from; empty means the profile the Desktop app starts on. */
  sourceProfile: string
  /** The test instance's own profile. */
  testProfile: string
  /** The debugging port the test instance listens on. */
  port: number
  /** Upper bound on a launch reaching a debuggable window, in milliseconds. */
  launchTimeoutMs: number
  /** Upper bound on one DevTools command, in milliseconds. */
  commandTimeoutMs: number
  keepFocus: boolean
  /** Cap on one `desktop_test_instance` result's text, in characters. */
  maxOutputChars: number
  /** The workspace root `build_workspace_package` builds in; empty means the one above the Session's working directory. */
  repoRoot: Volatile<string>
  /** Characters of output `build_workspace_package` keeps per step. */
  stepOutputChars: number
}

export const Config = z.object({
  desktopDir: z.string().default('').description('The installed Desktop app directory. Empty uses the Desktop app this Host runs inside.'),
  desktopExecutable: z.string().default('').description('The Desktop executable file name. Empty uses the executable this Host runs as.'),
  stateDir: z.string().default('').description('Where the app copy, its process record, its log, and screenshots live. Empty uses <dsh home>/desktop-test-instance.'),
  sourceProfile: z.string().default('').description('The profile the test profile is cloned from. Empty uses the profile the Desktop app starts on.'),
  testProfile: z.string().default('desktop-test-instance').description('The test instance\'s own profile name.'),
  port: z.natural().min(1024).max(65535).default(9333).description('The DevTools debugging port the test instance listens on.'),
  launchTimeoutMs: z.natural().min(1000).default(120_000).description('Milliseconds a launch may take to reach a debuggable window.'),
  commandTimeoutMs: z.natural().min(100).default(30_000).description('Milliseconds one DevTools command may take.'),
  keepFocus: z.boolean().default(true).description('On Windows, give the foreground back to the window that had it once the test window is up, so typing is not stolen.'),
  maxOutputChars: z.natural().min(200).default(20_000).description('Cap on one desktop_test_instance result, in characters.'),
  repoRoot: z.string().default('')
    .description('The workspace root build_workspace_package builds in. Empty finds it above the Session working directory, else uses the checkout this harness runs from.')
    .volatile(),
  stepOutputChars: z.natural().min(200).default(6000).description('Characters of output build_workspace_package keeps per step.'),
})

/**
 * Resolve the Desktop test instance's paths and limits from the config.
 * @param config - the plugin config.
 * @param execPath - the running executable.
 * @returns the spec, or the reason the Desktop app cannot be located.
 */
export function resolveInstanceSpec(config: Config, execPath: string = process.execPath): DesktopInstanceSpec | string {
  const running = runningDesktop(execPath)
  const appDir = config.desktopDir !== '' ? config.desktopDir : running?.dir
  const exeName = config.desktopExecutable !== '' ? config.desktopExecutable : running?.exe
  if (appDir === undefined || exeName === undefined) {
    return 'this Host runs under plain Node, not inside the Desktop app; set desktopDir and desktopExecutable in the harness-dev-tools config'
  }
  const dshHome = resolveDshHome()
  return {
    appDir,
    exeName,
    dshHome,
    stateDir: config.stateDir !== '' ? config.stateDir : join(dshHome, 'desktop-test-instance'),
    sourceProfile: config.sourceProfile !== '' ? config.sourceProfile : desktopProfile(dshHome),
    testProfile: config.testProfile,
    port: config.port,
    launchTimeoutMs: config.launchTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    keepFocus: config.keepFocus,
    nodeExecutable: execPath,
  }
}

/**
 * Register both tools; stop a test instance this Host started when the plugin unloads.
 * @param ctx - the plugin context.
 * @param config - the plugin config.
 */
/**
 * Where this package's code really lives. The profiles' package folder links each
 * package to the checkout, so following the link finds the workspace the harness
 * runs from.
 * @returns the real directory, or undefined when it cannot be read.
 */
export function installDir(): string | undefined {
  try {
    return realpathSync(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  let instance: DesktopTestInstance | undefined
  const current = (): DesktopTestInstance => {
    if (instance !== undefined) return instance
    const spec = resolveInstanceSpec(config)
    if (typeof spec === 'string') throw new Error(spec)
    instance = new DesktopTestInstance(spec)
    return instance
  }
  const dshHome = resolveDshHome()
  ctx.effect(() => ctx.tools.register(desktopTestInstanceTool(ctx, current, config.maxOutputChars)), 'harness-dev-tools: desktop_test_instance')
  ctx.effect(() => ctx.tools.register(buildWorkspacePackageTool({
    // Read at each call, so a live settings change applies without a restart.
    repoRoot: () => config.repoRoot.get(),
    installDir: installDir(),
    nodeExecutable: process.execPath,
    scratchDir: join(config.stateDir !== '' ? config.stateDir : join(dshHome, 'desktop-test-instance'), 'build'),
    stepOutputChars: config.stepOutputChars,
  })), 'harness-dev-tools: build_workspace_package')
  ctx.effect(() => async () => { await instance?.stop() }, 'harness-dev-tools: stop the test instance')
}
