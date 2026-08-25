import { spawnSync } from 'node:child_process'

const checks = ['format:check', 'typecheck', 'test', 'build', 'adapter:check', 'repo:check']
const pnpmCli = process.env.npm_execpath
const packageManager = process.env.npm_config_user_agent

if (!pnpmCli || !packageManager?.startsWith('pnpm/11.7.0 ')) {
  throw new Error(
    'Run this command through pnpm 11.7.0 so the pinned package manager is preserved.',
  )
}

for (const check of checks) {
  const result = spawnSync(process.execPath, [pnpmCli, 'run', check], {
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
