#!/usr/bin/env node
/**
 * Specs for the fork's profile registration step.
 *
 * Run with: node --test efai/ensure-profile-bundles.test.mjs
 *
 * The script is what makes the fork's plugins appear as installed external
 * plugins in the Web Plugins page, so the two facts worth pinning are that a
 * composed fork bundle is registered, and that a profile already carrying the
 * registration is left byte-identical.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ensureProfile, forkPluginsToRegister, placeForkBundles } from './ensure-profile-bundles.mjs'

/** Run one body against a throwaway harness home, restoring DSH_HOME afterwards. */
function withHome(body) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'efai-profiles-'))
  process.env.DSH_HOME = home
  try {
    return body(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

/** Write one profile manifest into a harness home. */
function writeProfile(home, name, manifest) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  return join(dir, 'package.json')
}

const FORK_BUNDLES = ['@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-efai-web']

test('placeForkBundles puts each fork bundle directly behind the bundle it extends', () => {
  assert.deepEqual(
    placeForkBundles(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']),
    ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web'],
  )
})

test('placeForkBundles returns the same array when every fork bundle is already placed', () => {
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web']
  assert.equal(placeForkBundles(bundles), bundles)
})

test('placeForkBundles leaves an upstream-only layer list without an anchor alone', () => {
  const bundles = ['@deepseek-ai/dsh-sdk-minimal']
  assert.equal(placeForkBundles(bundles), bundles)
})

test('forkPluginsToRegister names a composed bundle the profile has not installed', () => {
  assert.deepEqual(forkPluginsToRegister({}, FORK_BUNDLES), FORK_BUNDLES)
})

test('forkPluginsToRegister skips a bundle the profile already declares', () => {
  const manifest = { dependencies: { '@deepseek-ai/dsh-efai-base': '0.1.0-local.1' } }
  assert.deepEqual(forkPluginsToRegister(manifest, FORK_BUNDLES), ['@deepseek-ai/dsh-efai-web'])
})

test('forkPluginsToRegister registers only the fork bundles the profile composes', () => {
  assert.deepEqual(forkPluginsToRegister({}, ['@deepseek-ai/dsh-efai-base']), ['@deepseek-ai/dsh-efai-base'])
  assert.deepEqual(forkPluginsToRegister({}, ['@deepseek-ai/dsh-base']), [])
})

test('ensureProfile registers the fork bundles as installed plugins and keeps the layer list', () => {
  withHome(home => {
    const path = writeProfile(home, 'desktop', {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web'] } },
    })
    const reports = ensureProfile('desktop', false)
    assert.deepEqual(reports, ['desktop: installed @deepseek-ai/dsh-efai-base, @deepseek-ai/dsh-efai-web as an external plugin'])
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web',
    ])
    for (const name of FORK_BUNDLES) assert.equal(typeof manifest.dependencies[name], 'string')
  })
})

test('ensureProfile writes nothing on a profile that already carries the registration', () => {
  withHome(home => {
    const manifest = {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web'] } },
    }
    const path = writeProfile(home, 'desktop', manifest)
    ensureProfile('desktop', false)
    const first = readFileSync(path, 'utf8')
    assert.deepEqual(ensureProfile('desktop', false), [])
    assert.equal(readFileSync(path, 'utf8'), first)
  })
})

test('ensureProfile reports drift under --check without writing', () => {
  withHome(home => {
    const path = writeProfile(home, 'web', {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    })
    const before = readFileSync(path, 'utf8')
    const reports = ensureProfile('web', true)
    assert.deepEqual(reports, [
      'web: missing @deepseek-ai/dsh-efai-base, @deepseek-ai/dsh-efai-web',
      'web: @deepseek-ai/dsh-efai-base, @deepseek-ai/dsh-efai-web is composed but not installed',
    ])
    assert.equal(readFileSync(path, 'utf8'), before)
  })
})

test('ensureProfile initializes a missing template profile with its bundles installed', () => {
  withHome(home => {
    assert.deepEqual(ensureProfile('web', false), ['web: initialized with the fork bundles'])
    const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-efai-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-efai-web',
    ])
    for (const name of FORK_BUNDLES) assert.equal(typeof manifest.dependencies[name], 'string')
  })
})

test('ensureProfile refuses a profile with neither a manifest nor a template', () => {
  withHome(() => {
    assert.deepEqual(ensureProfile('nonesuch', false), ['nonesuch: no such profile and no template for it'])
  })
})
