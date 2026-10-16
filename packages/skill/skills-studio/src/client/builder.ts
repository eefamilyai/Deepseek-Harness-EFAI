/**
 * The Skill Builder's sessions: the one embedded in the Skills page, kept
 * across visits, and the ones opened in the main column.
 *
 * A Skill Builder session is an ordinary Session working in `~/.dsh/skills`.
 * Its composer starts with `@skill skill-builder `, the gesture that loads the
 * builder's instructions with the first message, so the user only adds what
 * the skill should do.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** One retained Session, as the panel holds it. */
export interface BuilderReference<Binding> {
  readonly sessionId: string
  readonly ready: Promise<Binding>
  release(): void
}

/** What the embedded panel shows. */
export type BuilderView<Reference> =
  | { readonly kind: 'closed' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'open'; readonly reference: Reference }
  | { readonly kind: 'failed'; readonly message: string }

/** The calls the builder makes. */
export interface BuilderDeps<Binding, Reference extends BuilderReference<Binding>> {
  /** Install the builder skill and learn where its sessions work. */
  start(): Promise<{ readonly cwd: string; readonly draft: string }>
  /** Create a Session in a folder. */
  create(cwd: string): Promise<string>
  /** Retain a Session. */
  retain(sessionId: string): Reference
  /** Put the first draft in a Session's composer. */
  setDraft(binding: Binding, draft: string): void
  /** Show a Session in the main column. */
  show(sessionId: string): void
  /** The embedded Session remembered from an earlier visit. */
  remembered(): string | null
  /** Remember the embedded Session, or forget it. */
  remember(sessionId: string | null): void
}

/**
 * The message of any thrown value.
 * @param error - the value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The embedded Skill Builder and the main-column launcher. */
export class SkillBuilder<Binding, Reference extends BuilderReference<Binding>> {
  /** What the embedded panel shows. */
  readonly view: SnapshotStore<BuilderView<Reference>> = createSnapshotStore<BuilderView<Reference>>({ kind: 'closed' })
  private held: Reference | undefined
  private generation = 0

  /** @param deps - the Session, Remote, and storage calls. */
  constructor(private readonly deps: BuilderDeps<Binding, Reference>) {}

  /** Show the embedded builder, reopening the remembered session. */
  open(): void {
    const kind = this.view.getSnapshot().kind
    if (kind === 'open' || kind === 'starting') return
    void this.begin(true)
  }

  /** Replace the embedded session with a fresh one. */
  fresh(): void {
    this.deps.remember(null)
    void this.begin(false)
  }

  /** Hide the embedded builder; its session stays in the session list. */
  close(): void {
    this.generation++
    this.drop()
    this.view.set({ kind: 'closed' })
  }

  /**
   * Start a Skill Builder session in the main column.
   * @returns null on success, or the reason it failed.
   */
  async launch(): Promise<string | null> {
    try {
      const start = await this.deps.start()
      const sessionId = await this.deps.create(start.cwd)
      const reference = this.deps.retain(sessionId)
      try {
        this.deps.setDraft(await reference.ready, start.draft)
        this.deps.show(sessionId)
      } finally {
        reference.release()
      }
      return null
    } catch (error: unknown) {
      return messageOf(error)
    }
  }

  /** Release the embedded session. */
  dispose(): void {
    this.close()
  }

  /**
   * Open the embedded session: the remembered one when asked and still there, otherwise a new one.
   * @param reuse - whether to reopen the remembered session.
   */
  private async begin(reuse: boolean): Promise<void> {
    const generation = ++this.generation
    this.drop()
    this.view.set({ kind: 'starting' })
    try {
      const start = await this.deps.start()
      let reference: Reference | undefined
      const remembered = reuse ? this.deps.remembered() : null
      if (remembered !== null) {
        const candidate = this.deps.retain(remembered)
        try {
          await candidate.ready
          reference = candidate
        } catch {
          candidate.release()
          this.deps.remember(null)
        }
      }
      if (reference === undefined) {
        const sessionId = await this.deps.create(start.cwd)
        this.deps.remember(sessionId)
        const created = this.deps.retain(sessionId)
        try {
          this.deps.setDraft(await created.ready, start.draft)
        } catch (error: unknown) {
          created.release()
          throw error
        }
        reference = created
      }
      if (generation !== this.generation) {
        reference.release()
        return
      }
      this.held = reference
      this.view.set({ kind: 'open', reference })
    } catch (error: unknown) {
      if (generation === this.generation) this.view.set({ kind: 'failed', message: messageOf(error) })
    }
  }

  /** Release the held session, if any. */
  private drop(): void {
    this.held?.release()
    this.held = undefined
  }
}
