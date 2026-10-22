/** Accounts per rotation read. A loop walks the rest by `accountId`, so one read never holds every due row. */
export const ROTATION_BATCH_SIZE = 500;
