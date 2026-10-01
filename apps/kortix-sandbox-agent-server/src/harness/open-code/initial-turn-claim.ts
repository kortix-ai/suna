import type { InitialTurnClaim } from '@/types/control-plane'

let claimedInitialTurn: InitialTurnClaim | null = null
export function getClaimedInitialTurn(): InitialTurnClaim | null { return claimedInitialTurn }
export function setClaimedInitialTurn(claim: InitialTurnClaim): void { claimedInitialTurn = claim }
export function resetClaimedInitialTurnForTests(): void { claimedInitialTurn = null }
