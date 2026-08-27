import {
  parseActionProposal,
  parseActionProposalStateTransition,
  parseDraft,
  parseDraftStateTransition,
} from './validation.ts'
import type {
  ActionProposal,
  ActionProposalStateTransition,
  Draft,
  DraftStateTransition,
} from './model.ts'

export type DomainStateTransitionErrorCode = 'identity_mismatch' | 'stale_state' | 'chronology'

export class DomainStateTransitionError extends Error {
  readonly code: DomainStateTransitionErrorCode

  constructor(code: DomainStateTransitionErrorCode, message: string) {
    super(message)
    this.name = 'DomainStateTransitionError'
    this.code = code
  }
}

function assertTransitionPreconditions(
  recordId: string,
  state: string,
  updatedAt: string,
  transitionRecordId: string,
  fromState: string,
  occurredAt: string,
): void {
  if (recordId !== transitionRecordId) {
    throw new DomainStateTransitionError(
      'identity_mismatch',
      'The state transition targets a different record.',
    )
  }
  if (state !== fromState) {
    throw new DomainStateTransitionError(
      'stale_state',
      'The state transition does not match the current state.',
    )
  }
  if (Date.parse(occurredAt) < Date.parse(updatedAt)) {
    throw new DomainStateTransitionError(
      'chronology',
      'The state transition precedes the current record.',
    )
  }
}

/** Apply one validated local Draft transition without performing any Tool or Connector call. */
export function applyDraftStateTransition(
  draftInput: Draft,
  transitionInput: DraftStateTransition,
): Draft {
  const draft = parseDraft(draftInput)
  const transition = parseDraftStateTransition(transitionInput)
  assertTransitionPreconditions(
    draft.id,
    draft.state,
    draft.updatedAt,
    transition.draftId,
    transition.fromState,
    transition.occurredAt,
  )
  return parseDraft({
    ...draft,
    state: transition.toState,
    updatedAt: transition.occurredAt,
  })
}

/** Apply one validated local proposal transition without approving or executing the action. */
export function applyActionProposalStateTransition(
  proposalInput: ActionProposal,
  transitionInput: ActionProposalStateTransition,
): ActionProposal {
  const proposal = parseActionProposal(proposalInput)
  const transition = parseActionProposalStateTransition(transitionInput)
  assertTransitionPreconditions(
    proposal.id,
    proposal.state,
    proposal.updatedAt,
    transition.proposalId,
    transition.fromState,
    transition.occurredAt,
  )
  return parseActionProposal({
    ...proposal,
    state: transition.toState,
    updatedAt: transition.occurredAt,
  })
}
