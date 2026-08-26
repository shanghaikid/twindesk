export type BuiltInPersonaId = 'technical-lead' | 'communication'
export type PersonaPresetProfile = 'technical_lead' | 'communication'

export interface PersonaConfiguration {
  readonly kind: 'persona_configuration'
  readonly schemaVersion: 1
  readonly id: BuiltInPersonaId
  readonly name: string
  readonly description: string
  readonly mission: string
  readonly tone: string
  readonly outputPreference: string
  readonly presetProfile: PersonaPresetProfile
  readonly autonomy: 'draft_only'
}

export interface PersonaPresetMapping {
  readonly configuration: PersonaConfiguration
  readonly presetId: string
  readonly advertisedSkills: readonly string[]
  readonly advertisedTools: readonly string[]
  readonly authorityEffect: 'none'
  readonly externalWritesAvailable: false
}

export type PersonaPresetMappingErrorCode =
  'invalid_configuration' | 'unknown_persona' | 'configuration_mismatch'

export class PersonaPresetMappingError extends TypeError {
  readonly code: PersonaPresetMappingErrorCode

  constructor(code: PersonaPresetMappingErrorCode, message: string) {
    super(message)
    this.name = 'PersonaPresetMappingError'
    this.code = code
  }
}

const CONFIGURATION_KEYS = Object.freeze([
  'kind',
  'schemaVersion',
  'id',
  'name',
  'description',
  'mission',
  'tone',
  'outputPreference',
  'presetProfile',
  'autonomy',
] as const)

const DEFINITIONS = Object.freeze([
  Object.freeze({
    configuration: Object.freeze({
      kind: 'persona_configuration',
      schemaVersion: 1,
      id: 'technical-lead',
      name: 'Technical Lead',
      description: 'Evidence-oriented technical assessment.',
      mission:
        'Evaluate technical facts, compatibility risks, dependencies, and reversible next steps before drafting a recommendation.',
      tone: 'Direct, evidence-oriented, and explicit about uncertainty.',
      outputPreference: 'A concise technical assessment with risks and a recommended decision.',
      presetProfile: 'technical_lead',
      autonomy: 'draft_only',
    } satisfies PersonaConfiguration),
    presetId: 'twindesk-technical-lead',
    advertisedSkills: Object.freeze(['technical-risk-review']),
    advertisedTools: Object.freeze([
      'skill',
      'subagent_codex',
      'twindesk_status',
      'twindesk_technical_context',
    ]),
  }),
  Object.freeze({
    configuration: Object.freeze({
      kind: 'persona_configuration',
      schemaVersion: 1,
      id: 'communication',
      name: 'Communication',
      description: 'Calm stakeholder communication.',
      mission: 'Turn verified facts into concise, calm, stakeholder-ready drafts.',
      tone: 'Calm, plain-language, and explicit about uncertainty.',
      outputPreference: 'A concise stakeholder update with the next checkpoint.',
      presetProfile: 'communication',
      autonomy: 'draft_only',
    } satisfies PersonaConfiguration),
    presetId: 'twindesk-communication',
    advertisedSkills: Object.freeze(['stakeholder-update']),
    advertisedTools: Object.freeze(['skill', 'twindesk_status']),
  }),
])

export const BUILT_IN_PERSONA_CONFIGURATIONS: readonly PersonaConfiguration[] = Object.freeze(
  DEFINITIONS.map(({ configuration }) => configuration),
)

/** Return installed Persona metadata without resolving or granting a capability. */
export function findBuiltInPersonaConfiguration(id: string): PersonaConfiguration | undefined {
  return BUILT_IN_PERSONA_CONFIGURATIONS.find((configuration) => configuration.id === id)
}

type UnknownRecord = Readonly<Record<string, unknown>>

function fail(code: PersonaPresetMappingErrorCode, message: string): never {
  throw new PersonaPresetMappingError(code, message)
}

function dataRecord(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid_configuration', 'The Persona configuration must be an object.')
  }
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('invalid_configuration', 'The Persona configuration must be plain data.')
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return fail('invalid_configuration', 'The Persona configuration has unsupported fields.')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const descriptor of Object.values(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value')) {
      return fail('invalid_configuration', 'The Persona configuration must contain data fields.')
    }
  }
  const actualKeys = Object.keys(descriptors)
  if (
    actualKeys.length !== CONFIGURATION_KEYS.length ||
    CONFIGURATION_KEYS.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    return fail('invalid_configuration', 'The Persona configuration shape is not supported.')
  }
  return value as UnknownRecord
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail('invalid_configuration', 'A Persona configuration field is invalid.')
  }
  return value
}

function parseConfiguration(value: unknown): PersonaConfiguration {
  const record = dataRecord(value)
  if (record.kind !== 'persona_configuration' || record.schemaVersion !== 1) {
    return fail('invalid_configuration', 'The Persona configuration version is not supported.')
  }
  const id = nonEmptyString(record.id)
  const presetProfile = nonEmptyString(record.presetProfile)
  if (id !== 'technical-lead' && id !== 'communication') {
    return fail('unknown_persona', 'The Persona is not installed.')
  }
  if (presetProfile !== 'technical_lead' && presetProfile !== 'communication') {
    return fail('invalid_configuration', 'The Persona Preset profile is not supported.')
  }
  if (record.autonomy !== 'draft_only') {
    return fail('invalid_configuration', 'The Persona cannot raise the autonomy boundary.')
  }
  return Object.freeze({
    kind: 'persona_configuration',
    schemaVersion: 1,
    id,
    name: nonEmptyString(record.name),
    description: nonEmptyString(record.description),
    mission: nonEmptyString(record.mission),
    tone: nonEmptyString(record.tone),
    outputPreference: nonEmptyString(record.outputPreference),
    presetProfile,
    autonomy: 'draft_only',
  })
}

function sameConfiguration(left: PersonaConfiguration, right: PersonaConfiguration): boolean {
  return CONFIGURATION_KEYS.every((key) => left[key] === right[key])
}

/**
 * Resolve one installed Persona's behavior to its pinned Harness Preset.
 * This mapping exposes no credential, Connector scope, policy grant, or write authority.
 */
export function mapPersonaConfigurationToPreset(value: unknown): PersonaPresetMapping {
  const configuration = parseConfiguration(value)
  const definition = DEFINITIONS.find(({ configuration: known }) => known.id === configuration.id)
  if (definition === undefined) return fail('unknown_persona', 'The Persona is not installed.')
  if (!sameConfiguration(configuration, definition.configuration)) {
    return fail(
      'configuration_mismatch',
      'The Persona configuration does not match its installed version.',
    )
  }
  return Object.freeze({
    configuration,
    presetId: definition.presetId,
    advertisedSkills: definition.advertisedSkills,
    advertisedTools: definition.advertisedTools,
    authorityEffect: 'none',
    externalWritesAvailable: false,
  })
}
