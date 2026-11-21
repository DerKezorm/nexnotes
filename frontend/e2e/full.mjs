/**
 * The full Playwright run, at the end of a stage (`npm run e2e:full`): everything `npm run e2e` does, with the long
 * list of `list.spec.ts` at the spec's 10,000 notes instead of the everyday 500 (NOTES-6 EC-2). More arguments go on to
 * Playwright, as with `npm run e2e -- …`.
 */
import { spawnSync } from 'node:child_process'

const result = spawnSync('npm', ['run', 'e2e', '--', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXNOTES_E2E_MANY: process.env.NEXNOTES_E2E_MANY ?? '10000' },
})
process.exit(result.status ?? 1)
