/**
 * The model-facing `site` tool: publish, list, check, and take down sites.
 *
 * @module @deepseek-ai/dsh-tool-sites/tool
 */

import { isAbsolute } from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Sites, SiteFileContent } from './sites.ts'

/** The actions `site` accepts. */
export const SITE_ACTIONS = ['publish', 'list', 'status', 'remove'] as const

/** One file as the model passes it. */
interface FileArg {
  path: string
  content: string
  base64?: boolean
}

/**
 * Turn the model's file list into a site's files.
 * @param files - the list.
 * @returns the files keyed by path.
 */
export function filesFrom(files: readonly FileArg[]): Record<string, SiteFileContent> {
  const out: Record<string, SiteFileContent> = {}
  for (const file of files) out[file.path] = file.base64 === true ? { base64: file.content } : file.content
  return out
}

/** What the tool needs from its plugin. */
export interface SiteToolDeps {
  /** The sites service, or the reason it cannot run (missing credentials). */
  readonly sites: () => Promise<Sites>
  /** Reads a folder into site files. */
  readonly readFolder: (dir: string) => Promise<Record<string, SiteFileContent>>
  /** The zone, for the description. */
  readonly zone: string
}

/**
 * Build the `site` tool.
 * @param deps - the service, folder reader, and zone.
 * @returns the tool definition.
 */
export function siteTool(deps: SiteToolDeps): ToolDefinition {
  return defineTool({
    name: 'site',
    description: `Publish a static web page or small web app at https://<name>.${deps.zone} and show it to the user.`
      + ' Use it whenever a result is better seen than read: illustrations and animations (SVG, canvas, CSS), slide decks,'
      + ' interactive explainers and simulations, charts and dashboards, diagrams, reports, prototypes and mockups, small games.'
      + ' Actions: publish (create or replace a whole site: give `files` inline, or `dir`, an absolute local folder; index.html is'
      + ' required; relative links only; libraries from a CDN are fine), list (every site), status (DNS, Pages build, HTTPS'
      + ' certificate, and whether the address answers), remove (take a site down; its repository is archived, not deleted).'
      + ' Each site is a public GitHub repository served by GitHub Pages, so never publish secrets or private data.'
      + ' Publishing waits for the build; a NEW name can take a few minutes to resolve and up to ~30 minutes to get HTTPS'
      + ' (http works meanwhile). Republishing to an existing name updates it within a minute. Give the user the returned URL.',
    parameters: {
      action: { type: 'string', enum: [...SITE_ACTIONS], required: true, description: 'publish, list, status, or remove.' },
      name: {
        type: 'string',
        description: 'The site name and subdomain (publish, status, remove): 1-40 lowercase letters, digits, and inner hyphens, like "solar-system".',
      },
      files: {
        type: 'array',
        description: 'publish: every file of the site. Set base64 for binary content (images, fonts).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Path inside the site, e.g. index.html or assets/app.js.' },
            content: { type: 'string', required: true, description: 'The file text, or base64 bytes when base64 is true.' },
            base64: { type: 'boolean', description: 'Whether content is base64-encoded bytes.' },
          },
        },
      },
      dir: { type: 'string', description: 'publish: an absolute local folder to publish instead of files (.git and node_modules are skipped).' },
      title: { type: 'string', description: 'publish: a one-line title for the site list.' },
      wait_seconds: { type: 'integer', description: 'publish: seconds to wait for the Pages build (default 90; 0 returns at once).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, url: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const sites = await deps.sites()
      const need = (): string => {
        if (args.name === undefined || args.name === '') throw new Error(`site ${args.action} needs a name`)
        return args.name
      }
      if (args.action === 'list') {
        const all = await sites.list()
        if (all.length === 0) return { text: 'No sites yet.' }
        return {
          text: all.map(site => `- ${site.name}: ${site.url}${site.title === '' ? '' : ` — ${site.title}`}`
            + `${site.live ? '' : ' (taken down)'}${site.dns || !site.live ? '' : ' (no DNS name)'}`).join('\n'),
        }
      }
      if (args.action === 'status') {
        const s = await sites.status(need())
        return {
          url: s.url,
          text: [
            `${s.name}: ${s.url}`,
            `- repository: ${s.repo ?? 'none'}${s.archived ? ' (archived: taken down)' : ''}`,
            `- DNS: ${s.dns ?? 'no record'}`,
            `- Pages: ${s.pages ?? 'off'}; latest build ${s.build ?? 'none'}${s.buildError === null ? '' : ` (${s.buildError})`}`,
            `- HTTPS certificate: ${s.certificate ?? 'none'}${s.httpsEnforced ? ', enforced' : ''}`,
            `- answers: http ${s.reachable.http}; https ${s.reachable.https}`,
          ].join('\n'),
        }
      }
      if (args.action === 'remove') return { text: (await sites.remove(need())).map(line => `- ${line}`).join('\n') }
      const name = need()
      if (args.dir !== undefined && args.files !== undefined) throw new Error('give files or dir, not both')
      let files: Record<string, SiteFileContent>
      if (args.dir !== undefined) {
        if (!isAbsolute(args.dir)) throw new Error('dir must be an absolute path')
        files = await deps.readFolder(args.dir)
      } else if (args.files !== undefined) {
        files = filesFrom(args.files)
      } else {
        throw new Error('site publish needs files or dir')
      }
      const result = await sites.publish({
        name, files,
        ...args.title === undefined ? {} : { title: args.title },
        ...args.wait_seconds === undefined ? {} : { waitSeconds: args.wait_seconds },
      })
      return {
        url: result.url,
        text: [
          `${result.created ? 'Created' : 'Updated'} ${result.url} (${String(result.files)} files, ${String(result.bytes)} bytes; build ${result.build}).`,
          `Source: ${result.repo}`,
          ...result.notes,
        ].join('\n'),
      }
    },
  })
}
