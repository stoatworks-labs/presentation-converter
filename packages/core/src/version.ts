/**
 * Recorded in every sidecar's `generator` field, so a deck can be traced back
 * to the build that produced it, and reported by the CLI's --version and its
 * `about` command.
 *
 * This has to match the package versions, and "keep it in step" was not enough:
 * it said 0.1.0 through the v0.1.1 and v0.1.2 releases, so every sidecar
 * written in that time records a generator two versions behind the build that
 * actually wrote it. test/version.test.ts now fails if they drift again.
 */
export const VERSION = '0.2.0'
export const GENERATOR = `presentation-converter ${VERSION}`
