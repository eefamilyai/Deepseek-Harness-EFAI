/**
 * The account-mute verdict must not borrow a retryable failure code.
 *
 * `ds_direct` raises `_Muted` when DeepSeek answers an HTTP 200 with the nested
 * `data.biz_code` mute verdict, and the sidecar reports that to this adapter as
 * `meta{finish:'error'}`. Before {@link ACCOUNT_MUTED_CODE} existed, every such
 * refusal fell through to `TRANSPORT` -- a code the harness's default retry
 * policy retries five times with a sub-second backoff.
 *
 * That is not a cosmetic mislabel. A mute is an account-level moderation
 * verdict whose expiry is measured in DAYS, so every retry is one more request
 * against an account the provider has already refused. On 2026-09-29 the
 * account `jw1` was muted for 72 h, the connector kept sending for the next two
 * hours, and the penalty escalated to 216 h. The classification below is what
 * makes the first verdict final.
 */
import { describe, expect, it } from 'vitest'
import { ACCOUNT_MUTED_CODE, isMutedAccount, isRateLimit } from '@deepseek-ai/dsh-llm-kiln'

/** The exact body `ds_direct` raised on, as the sidecar reports it. */
const MUTE_BODY = '{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted",'
  + '"biz_data":{"is_muted":1,"mute_until":1790932407.459}}}'

describe('an account mute is its own failure class', () => {
  it('names a code outside the retryable set', () => {
    expect(ACCOUNT_MUTED_CODE).toBe('ACCOUNT_MUTED')
  })

  it('reads the message the sidecar actually sends', () => {
    expect(isMutedAccount(
      'DeepSeek has muted this account: user is muted (until 2026-10-08 11:16 UTC). '
      + 'This is an account-level moderation verdict, not a credential or session problem.',
    )).toBe(true)
  })

  it('reads the mute verdict in the raw body too', () => {
    expect(isMutedAccount(MUTE_BODY)).toBe(true)
  })

  it('does not mistake a rate limit or a bridge fault for a mute', () => {
    expect(isMutedAccount('DeepSeek 429: rate-limited')).toBe(false)
    expect(isMutedAccount('the Kiln provider bridge is missing')).toBe(false)
    expect(isMutedAccount('DeepSeek returned an empty response (HTTP 200)')).toBe(false)
  })

  it('leaves a mute body unclaimed by the rate-limit classifier', () => {
    // The mute branch is checked first, so this pins that the two vocabularies
    // stay disjoint -- a mute read as RATE_LIMIT would inherit its retry loop.
    expect(isRateLimit(MUTE_BODY)).toBe(false)
    expect(isRateLimit('DeepSeek has muted this account: user is muted')).toBe(false)
  })
})
