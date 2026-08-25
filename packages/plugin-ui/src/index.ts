/** Stable Host loader entry that enrolls the package's `dsh.client` half. */
export const name = 'twindesk-ui'

/** The Stage 0 Host half owns no service dependency. */
export const inject: readonly string[] = []

/** Client behavior is discovered from package metadata; the Host half is intentionally empty. */
export function apply(): void {}
