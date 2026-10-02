/**
 * The account-pool vocabulary the `aiAccounts` service speaks, and its Remote
 * failure code.
 *
 * A Remote method's parameter and result types must be exported from a public
 * non-root subpath for the Typert generator, which is why this module exists
 * separately from `./index.ts`.
 *
 * @module @deepseek-ai/dsh-ai-accounts/types
 */

/** One login being tested by an account-pooling provider (e.g. DeepSeek web). */
export interface AccountDraft {
  /** Login email, when the account signs in with one. */
  readonly email?: string
  /** Login mobile, when the account signs in with one. */
  readonly mobile?: string
  /** Area code for a mobile login. */
  readonly area_code?: string
  /** Password, used only to test the login; never stored or returned by this service. */
  readonly password: string
}

/** The outcome of adding one account: its id and new route on success, or a reason. */
export interface AccountAddResult {
  /** Whether the login tested successfully and the account was added. */
  readonly ok: boolean
  /** The added login id, on success. */
  readonly account?: string
  /** The route now bound to that login, on success (selectable immediately). */
  readonly route?: string
  /** A plain failure reason, on failure - never the credential. */
  readonly message?: string
}

/**
 * One label/value row a provider reports about an account.
 *
 * A row is how a provider says something this service has no field for, so a
 * second account-pooling provider adds its own identity rows without changing
 * this interface.
 */
export interface AccountField {
  /** Human-readable field name, e.g. `X device id`. */
  readonly label: string
  /** The field's value. Never a credential - see {@link AccountInfo}. */
  readonly value: string
}

/**
 * One pooled login, as an operator surface reads it.
 *
 * Identity describes a DEVICE and belongs to the operator; a credential
 * authorizes a SESSION and does not. So a row reports whether a token, cookie,
 * or password is PRESENT and never its value - the only values that ride here
 * are the ones naming the device the login is presented from.
 */
export interface AccountInfo {
  /** The login id, as the provider names it (the route suffix). */
  readonly id: string
  /**
   * The browser-profile slug this login's identity lives under.
   *
   * `id` and `slug` are different handles on the same account: the id names the
   * config slot, the slug names the profile directory and the identity record.
   * An orphan carries ONLY a slug, because the id it was configured under is
   * exactly what is gone - so both travel, and a caller addresses whichever one
   * it has.
   */
  readonly slug: string
  /** The provider route that pools this login. */
  readonly provider: string
  /** A short human label for the list row. */
  readonly label: string
  /** Whether the login is currently in the provider's account pool. */
  readonly configured: boolean
  /** Provider-reported identity rows, in display order. */
  readonly fields: readonly AccountField[]
}

/** One operator-facing debug line about account activity. */
export interface AccountLogEntry {
  /** Monotonic sequence number, unique within one provider. */
  readonly seq: number
  /** Unix seconds the event was recorded. */
  readonly at: number
  /** The account the event is attributed to. */
  readonly account: string
  /** Short event name, e.g. `login`, `relogin`, `reprofile`. */
  readonly event: string
  /** Severity: `info`, `warn`, or `error`. */
  readonly level: string
  /** A plain human sentence; never a credential. */
  readonly detail: string
}

/** The outcome of one repair operation on one account. */
export interface AccountOpResult {
  /** Whether the operation succeeded. */
  readonly ok: boolean
  /** The account operated on, when the id resolved. */
  readonly account?: string
  /** A plain failure reason, on failure. */
  readonly message?: string
}

/** Tests a login and, on success, makes it a selectable route for its provider. */
export type AccountAdder = (account: AccountDraft) => Promise<AccountAddResult>

/**
 * The account-administration half of an account-pooling provider: what an
 * operator surface reads, and the repairs it can ask for.
 *
 * `list` is the read. `relogin` re-authenticates a login whose session has gone
 * stale. `reprofile` replaces the browser identity a login presents, which is
 * the repair for a device fingerprint that has been flagged - a fresh identity
 * rather than the same one again. `log` is the per-account debug trail that
 * makes two logins running at once legible.
 *
 * A provider that pools accounts registers one of these alongside its
 * {@link AccountAdder}, exactly as it registers the adder.
 */
export interface AccountAdmin {
  /**
   * Every login the provider pools, plus any it holds identity for but has not
   * configured - an orphan is what an operator needs to see, not what to hide.
   * @returns one row per login, in the provider's own order.
   */
  list: () => Promise<readonly AccountInfo[]>
  /**
   * Re-authenticate one login, refreshing the credentials it serves with.
   * @param account - the login id to re-authenticate.
   * @returns whether the login now works, or a plain reason it does not.
   */
  relogin: (account: string) => Promise<AccountOpResult>
  /**
   * Replace one login's browser identity, so it presents as a new device.
   * @param account - the login id to re-profile.
   * @returns whether a fresh identity is in place, or a plain reason not.
   */
  reprofile: (account: string) => Promise<AccountOpResult>
  /**
   * Forget one login, or one orphaned identity, from the provider's list.
   *
   * The repair for an entry that should not be there at all - a login that was
   * replaced, or a profile a removed one left behind. The browser identity
   * survives unless `purge` is set: it cost a real login to mint, and a
   * replacement account can still present it, so destroying it is a separate
   * decision rather than part of forgetting the login.
   * @param account - the login id to forget; '' when only a slug is known.
   * @param slug - the profile slug, which is all an orphan carries.
   * @param purge - also delete the browser profile. Default false.
   * @returns whether the entry is gone, or a plain reason it is not.
   */
  remove: (account: string, slug: string, purge: boolean) => Promise<AccountOpResult>
  /**
   * Debug lines recorded since a sequence number, oldest first.
   * @param since - return only entries with a higher sequence number.
   * @returns the entries, in recording order.
   */
  log: (since: number) => Promise<readonly AccountLogEntry[]>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** An account addition was refused: unknown route, or an invalid draft. */
    'aiAccounts/account-rejected': {
      readonly provider: string
      readonly account?: string
    }
  }
}
