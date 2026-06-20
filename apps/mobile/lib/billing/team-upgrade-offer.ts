export interface TeamUpgradeAccountState {
  can_manage_billing?: boolean;
  member_count?: number;
  seats?: {
    count?: number;
    price_per_seat_usd?: number;
  };
}

export interface TeamUpgradeOffer {
  canManageBilling: boolean;
  pricePerSeat: number;
  seatCount: number;
  monthlyTotal: number;
  hasSeatMath: boolean;
}

export function getTeamUpgradeOffer(accountState?: TeamUpgradeAccountState): TeamUpgradeOffer {
  const pricePerSeat = accountState?.seats?.price_per_seat_usd ?? 40;
  const seatCount = Math.max(1, accountState?.member_count ?? accountState?.seats?.count ?? 1);

  return {
    canManageBilling: accountState?.can_manage_billing !== false,
    pricePerSeat,
    seatCount,
    monthlyTotal: pricePerSeat * seatCount,
    hasSeatMath: seatCount > 1,
  };
}
