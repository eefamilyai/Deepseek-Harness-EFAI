/**
 * The dependencies every HTTP handler receives.
 *
 * @module dswg/api/services
 */

import type { Config } from '../config.ts'
import type { AccountRepo } from '../store/accounts.ts'
import type { KeyRepo } from '../store/keys.ts'
import type { UsageRepo } from '../store/usage.ts'
import type { BrowserPool } from '../browser/pool.ts'
import type { TurnEngine } from '../engine/turn.ts'
import type { AccountSelector } from '../engine/accounts.ts'
import type { WireLog } from '../store/wirelog.ts'
import type { Corpus } from '../store/corpus.ts'
import type { PatternStore } from '../tools/learn.ts'

/** Shared services wired once at boot. */
export interface Services {
  config: Config
  accounts: AccountRepo
  keys: KeyRepo
  usage: UsageRepo
  pool: BrowserPool
  engine: TurnEngine
  selector: AccountSelector
  wire: WireLog
  corpus: Corpus
  patterns: PatternStore
  startedAt: number
  version: string
}
