/**
 * The profile vocabulary the `profileHub` service speaks, and its Remote
 * failure code.
 *
 * A Remote method's parameter and result types must be exported from a public
 * non-root subpath for the Typert generator, which is why this module exists
 * separately from `./index.ts`.
 *
 * @module @deepseek-ai/dsh-profile-hub/types
 */

/** One profile directory, as the landing page lists it. */
export interface ProfileSummary {
  /** The profile name, which is also its directory basename and `dsh --profile` argument. */
  readonly name: string
  /** Display title: the profile's own metadata, else its name. */
  readonly title: string
  /** Working directory a launched host starts in, when the profile declares one. */
  readonly workdir?: string
  /** The bundle layers this profile composes, in `dsh.profile.bundles` order. */
  readonly bundles: readonly string[]
  /**
   * Whether the profile keeps its own chats, workspaces, and credentials inside
   * its own directory. A profile that does not is sharing the harness home with
   * every other profile, which is what the landing page reports rather than
   * implying an isolation that is not there.
   */
  readonly isolated: boolean
  /** Chats recorded under this profile's own session root; absent when the root is shared. */
  readonly chats?: number
  /**
   * Whether the profile is off limits to this surface: the Electron
   * application's own reserved profile, or a name the installation ships and
   * initializes itself.
   */
  readonly locked: boolean
  /** Whether this is the profile the running host booted. */
  readonly current: boolean
  /** Whether this profile is the one that opens the landing page. */
  readonly launcher: boolean
  /** Whether this hub started a host for the profile and that host is still alive. */
  readonly running: boolean
  /** The authenticated URL of the host this hub started, when one is running. */
  readonly url?: string
}

/** Everything the landing page renders for one host. */
export interface ProfileHubState {
  /** The harness home every profile lives under. */
  readonly home: string
  /** The profiles directory. */
  readonly profilesDir: string
  /** The profile this host booted. */
  readonly current: string
  /** The profile whose startup opens the landing page. */
  readonly launcher: string
  /** Whether THIS host should open the landing page: it booted the launcher profile. */
  readonly landing: boolean
  /**
   * Whether this host can launch another profile. A host with no resolvable
   * spawn target (a bare process, a test) still lists and edits profiles.
   */
  readonly canLaunch: boolean
  /** Whether this host can open a profile as a Desktop window instead of a browser tab. */
  readonly canOpenDesktop: boolean
  /** Every profile on this machine, launcher first, then by name. */
  readonly profiles: readonly ProfileSummary[]
}

/** The profile to create. */
export interface CreateProfileRequest {
  /** Directory name and `dsh --profile` argument; must be unused and a valid profile name. */
  readonly name: string
  /** Display title; defaults to the name. */
  readonly title?: string
  /** Working directory a launched host starts in. */
  readonly workdir?: string
  /**
   * Whether to start from the running profile's own patch layer, so the new
   * profile boots with the same tuning this one has. Defaults to true; false
   * starts from an empty layer.
   */
  readonly clone?: boolean
}

/**
 * Where entering a profile opens it.
 *
 * `app` opens a second Desktop window, which owns the profile's directory and
 * Host process exactly as the primary window owns its own; `browser` starts the
 * profile as a plain Web Host and answers the URL to enter it at.
 */
export type OpenProfileTarget = 'app' | 'browser'

/** The outcome of entering a profile. */
export interface OpenProfileResult {
  /** Which surface the launch opened. */
  readonly opened: OpenProfileTarget
  /** The URL to enter, for the browser target. A Desktop window answers its own. */
  readonly url?: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A profile operation was refused: an invalid name, a locked profile, or a failed launch. */
    'profileHub/rejected': {
      /** The operation that was refused. */
      readonly action: string
      /** The profile name, when the operation named one. */
      readonly profile?: string
    }
  }
}
