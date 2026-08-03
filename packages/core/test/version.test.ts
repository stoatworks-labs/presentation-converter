import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { VERSION } from '../src/version.ts'

/*
 * VERSION is hand-written, and it went stale: it said 0.1.0 through both the
 * v0.1.1 and the v0.1.2 releases, so the `generator` field in every sidecar
 * written in that time names a build that never produced it. A release bumps
 * package.json; this makes forgetting version.ts a failing test rather than a
 * wrong number in a file someone reads a year later.
 */
test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})
