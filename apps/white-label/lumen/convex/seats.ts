/** The seat rule: active members plus pending invitations may not reach the seat count. */
export function seatAvailable(seats: number, members: number, pending: number) {
  return members + pending < seats;
}
