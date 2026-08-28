import { FeishuRuntimeLeaseManager } from '../../packages/plugin-feishu/dist/index.js'

const configuration = {
  kind: 'feishu_identity_configuration',
  schemaVersion: 1,
  connectorId: 'feishu',
  accountId: 'feishu-account:synthetic-runtime-lease-child',
  appId: 'cli_synthetic_runtime_lease_child',
  bot: {
    identityType: 'bot',
    displayName: 'Synthetic Runtime Lease Child',
    principalId: 'cli_synthetic_runtime_lease_child',
    credentialReference: {
      kind: 'secret_reference',
      schemaVersion: 1,
      id: 'secret-ref:synthetic-runtime-lease-child',
      store: 'system_keychain',
      purpose: 'connector_app_credential',
    },
  },
}

await new FeishuRuntimeLeaseManager().withLease(
  configuration,
  new AbortController().signal,
  async (lease) => {
    lease.assertHeld()
    process.send?.('ready')
    await new Promise(() => undefined)
  },
)
