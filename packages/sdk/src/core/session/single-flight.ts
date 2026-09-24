/**
 * Same-tick single-flight: callers that ask for the same key inside ONE
 * macrotask share one request.
 *
 * WHY "same tick" and not "while in flight". A read of server truth answers
 * the question as of the instant it was ISSUED. A trigger that arrives while a
 * read is already on the wire — a status frame, a queue drain — is news that
 * read cannot contain, so joining it would hand the new trigger a stale answer.
 * Callers inside the same macrotask were caused by the same event (several
 * components' effects in one React commit), so one read answers all of them.
 *
 * The window closes on the next macrotask (`setTimeout(0)`), not on settle, so
 * a slow request cannot widen it. The entry is dropped on settle either way.
 *
 * Internal: not exported from any public entry point.
 */

type Schedule = (callback: () => void) => void;

interface Flight<T> {
  promise: Promise<T>;
  joinable: boolean;
}

const defaultSchedule: Schedule = (callback) => {
  setTimeout(callback, 0);
};

export function createTickSingleFlight<T>(schedule: Schedule = defaultSchedule) {
  const flights = new Map<string, Flight<T>>();
  return function run(key: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const current = flights.get(key);
    if (current?.joinable) return current.promise;
    const flight: Flight<T> = { promise: read(), joinable: true };
    flights.set(key, flight);
    schedule(() => {
      flight.joinable = false;
    });
    const drop = () => {
      if (flights.get(key) === flight) flights.delete(key);
    };
    flight.promise.then(drop, drop);
    // A CANCELLED read leaves the flight at once. Its caller cancelled it to
    // write (a mutation's `cancelQueries`), and the read that follows the
    // write asks a question this one cannot answer. Joining it inherited a
    // request nobody awaits any more — one that may never settle.
    if (signal) {
      const leave = () => {
        flight.joinable = false;
        drop();
      };
      if (signal.aborted) leave();
      else signal.addEventListener('abort', leave, { once: true });
    }
    return flight.promise;
  };
}
