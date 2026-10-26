const DEFAULT_LIMITS = Object.freeze({
  'adverse-media': 2,
  'merchant-screening': 2,
  'bank-statement-analysis': 4,
  'entity-search': 2,
  'entity-search-report': 2,
  'iban-verification': 4,
  'uae-trade-licence': 2,
  forms: 8
});

export class CapacityError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export function createRequestCapacity({
  globalLimit = 16,
  defaultLaneLimit = 4,
  laneLimits = DEFAULT_LIMITS,
  maximumWaiting = 96,
  maximumWaitMs = 60_000,
  clock = () => Date.now()
} = {}) {
  const activeByLane = new Map();
  const waiting = [];
  let active = 0;

  function releaseFor(lane) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const remaining = (activeByLane.get(lane) || 1) - 1;
      if (remaining) activeByLane.set(lane, remaining);
      else activeByLane.delete(lane);
      drain();
    };
  }

  function canStart(lane) {
    return active < globalLimit && (activeByLane.get(lane) || 0) < (laneLimits[lane] || defaultLaneLimit);
  }

  function start(entry) {
    active += 1;
    activeByLane.set(entry.lane, (activeByLane.get(entry.lane) || 0) + 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(releaseFor(entry.lane));
  }

  function remove(entry, reason) {
    const index = waiting.indexOf(entry);
    if (index < 0) return;
    waiting.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.reject(new CapacityError(reason));
  }

  function drain() {
    for (let index = 0; index < waiting.length && active < globalLimit;) {
      const entry = waiting[index];
      if (entry.deadline <= clock()) {
        remove(entry, 'capacity_wait_timeout');
        continue;
      }
      if (!canStart(entry.lane)) { index += 1; continue; }
      waiting.splice(index, 1);
      start(entry);
    }
  }

  function acquire(lane, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new CapacityError('request_cancelled'));
    if (canStart(lane) && !waiting.some((entry) => entry.lane === lane)) {
      active += 1;
      activeByLane.set(lane, (activeByLane.get(lane) || 0) + 1);
      return Promise.resolve(releaseFor(lane));
    }
    if (waiting.length >= maximumWaiting) return Promise.reject(new CapacityError('capacity_queue_full'));
    return new Promise((resolve, reject) => {
      const entry = { lane, resolve, reject, signal, deadline: clock() + maximumWaitMs };
      entry.onAbort = () => remove(entry, 'request_cancelled');
      entry.timer = setTimeout(() => remove(entry, 'capacity_wait_timeout'), maximumWaitMs);
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      waiting.push(entry);
      drain();
    });
  }

  return { acquire, snapshot: () => ({ active, waiting: waiting.length, activeByLane: Object.fromEntries(activeByLane) }) };
}
