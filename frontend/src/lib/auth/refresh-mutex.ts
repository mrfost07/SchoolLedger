export function createSingleFlight<T>() {
  let inflight: Promise<T> | null = null;

  return function run(fn: () => Promise<T>): Promise<T> {
    if (!inflight) {
      inflight = fn().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

export function createKeyedSingleFlight<K, T>() {
  const flights = new Map<K, Promise<T>>();

  return function run(key: K, fn: () => Promise<T>): Promise<T> {
    const existing = flights.get(key);
    if (existing) return existing;
    const flight = fn().finally(() => {
      flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  };
}
