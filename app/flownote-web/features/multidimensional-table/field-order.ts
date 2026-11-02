export function sortFields<T>(items: T[], getId: (item: T) => string, order: readonly string[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((left, right) => (rank.get(getId(left)) ?? order.length) - (rank.get(getId(right)) ?? order.length));
}
