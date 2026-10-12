/** The fields of Cal.com's `bookingSuccessfulV2` embed event that we read. */
export interface CalBooking {
  uid?: string;
  title?: string;
  startTime?: string;
  endTime?: string;
}

type BookingListener = (e: CustomEvent<{ data: CalBooking }>) => void;

/** The `on` / `off` slice of the Cal.com embed API (`getCalApi`). */
export type CalEventApi = (
  method: 'on' | 'off',
  args: { action: 'bookingSuccessfulV2'; callback: BookingListener },
) => void;

/**
 * Listen for a completed booking and return the cleanup. The embed API keeps
 * listeners per namespace for the life of the page, so a listener that is
 * never removed fires again on every later booking, once per modal open.
 */
export function subscribeBookingSuccess(
  cal: CalEventApi,
  onBooked: (booking: CalBooking) => void,
): () => void {
  const callback: BookingListener = (e) => onBooked(e.detail.data);
  cal('on', { action: 'bookingSuccessfulV2', callback });
  return () => cal('off', { action: 'bookingSuccessfulV2', callback });
}

export interface BookedSlot {
  month: string;
  day: string;
  weekday: string;
  time: string;
  zone: string;
  minutes: number;
}

/** The booked slot, in the viewer's locale and time zone. */
export function formatBookedSlot(
  booking: CalBooking,
  locale?: string,
  timeZone?: string,
): BookedSlot | null {
  const start = new Date(booking.startTime ?? '');
  const end = new Date(booking.endTime ?? '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone, ...options });
  const zone = part({ timeZoneName: 'short' })
    .formatToParts(start)
    .find((p) => p.type === 'timeZoneName')?.value;

  return {
    month: part({ month: 'short' }).format(start),
    day: part({ day: '2-digit' }).format(start),
    weekday: part({ weekday: 'short' }).format(start),
    time: part({ hour: 'numeric', minute: '2-digit' }).formatRange(start, end),
    zone: zone ?? '',
    minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
  };
}
