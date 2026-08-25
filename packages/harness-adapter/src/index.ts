import cordisManifest from '@deepseek-ai/cordis/package.json' with { type: 'json' }
import appBootManifest from '@deepseek-ai/dsh-app-boot/package.json' with { type: 'json' }
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { DshProfileManifest as UpstreamProfileManifest } from '@deepseek-ai/dsh-app-boot'

export const SUPPORTED_CORDIS_VERSION = '4.0.1'
export const SUPPORTED_HARNESS_VERSION = '0.1.1-rc.2'

type HasCordisLifecycle = 'effect' | 'plugin' extends keyof CordisContext ? true : never
type HasProfileBundles = UpstreamProfileManifest extends { bundles?: string[] } ? true : never

const hasCordisLifecycle: HasCordisLifecycle = true
const hasProfileBundles: HasProfileBundles = true

export interface HarnessCompatibility {
  readonly cordisVersion: typeof SUPPORTED_CORDIS_VERSION
  readonly harnessVersion: typeof SUPPORTED_HARNESS_VERSION
  readonly contracts: {
    readonly cordisLifecycle: true
    readonly profileBundles: true
  }
}

export class UnsupportedHarnessVersionError extends Error {
  readonly code = 'UNSUPPORTED_HARNESS_VERSION'
  readonly packageName: string
  readonly expected: string
  readonly actual: string

  constructor(packageName: string, expected: string, actual: string) {
    super(`Unsupported ${packageName} version: expected ${expected}, received ${actual}`)
    this.name = 'UnsupportedHarnessVersionError'
    this.packageName = packageName
    this.expected = expected
    this.actual = actual
  }
}

function assertVersion(packageName: string, expected: string, actual: string): void {
  if (actual !== expected) {
    throw new UnsupportedHarnessVersionError(packageName, expected, actual)
  }
}

export function inspectHarnessCompatibility(): HarnessCompatibility {
  assertVersion('@deepseek-ai/cordis', SUPPORTED_CORDIS_VERSION, cordisManifest.version)
  assertVersion('@deepseek-ai/dsh-app-boot', SUPPORTED_HARNESS_VERSION, appBootManifest.version)

  return Object.freeze({
    cordisVersion: SUPPORTED_CORDIS_VERSION,
    harnessVersion: SUPPORTED_HARNESS_VERSION,
    contracts: Object.freeze({
      cordisLifecycle: hasCordisLifecycle,
      profileBundles: hasProfileBundles,
    }),
  })
}
