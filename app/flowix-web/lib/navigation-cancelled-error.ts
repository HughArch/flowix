/** A refused save/leave is cancellation, not a failed document in a batch. */
export class NavigationCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NavigationCancelledError';
  }
}
