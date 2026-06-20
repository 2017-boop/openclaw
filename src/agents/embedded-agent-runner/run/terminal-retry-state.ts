export const MAX_BEFORE_AGENT_FINALIZE_REVISIONS = 10; // was 3

export type EmbeddedRunTerminalRetryState = {
  reasoningOnlyAttempts: number;
  emptyResponseAttempts: number;
  missingAssistantAttempts: number;
  compactionContinuationAttempts: number;
  compactionContinuationInstruction: string | null;
  beforeFinalizeRevisionAttempts: number;
  codeModeReconciliationAttempts: number;
  forceCodeModeReconciliationTools: boolean;
};

export function createEmbeddedRunTerminalRetryState(): EmbeddedRunTerminalRetryState {
  return {
    reasoningOnlyAttempts: 0,
    emptyResponseAttempts: 0,
    missingAssistantAttempts: 0,
    compactionContinuationAttempts: 0,
    compactionContinuationInstruction: null,
    beforeFinalizeRevisionAttempts: 0,
    codeModeReconciliationAttempts: 0,
    forceCodeModeReconciliationTools: false,
  };
}
