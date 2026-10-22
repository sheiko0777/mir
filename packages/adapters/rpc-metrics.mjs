import { performance } from 'node:perf_hooks';

// Measure logical adapter calls, including its internal retry/backoff time.
// No payloads, URLs or responses are retained in telemetry.
export function measureRpc(read, { maxCalls = 1000, maxElapsedMs = 180000,
  clock = () => performance.now() } = {}) {
  if (typeof read !== 'function' || typeof clock !== 'function' ||
      !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10000 ||
      !Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) throw new Error('Invalid RPC measurement policy');
  const started = clock();
  let admitted = 0, succeeded = 0, failed = 0, budgetRejected = 0;
  const durations = [];
  const rpc = async (...args) => {
    const begin = clock();
    if (admitted >= maxCalls || begin - started >= maxElapsedMs) {
      budgetRejected++;
      throw new Error('Research RPC/time budget exhausted');
    }
    admitted++;
    try {
      const result = await read(...args);
      succeeded++;
      return result;
    } catch (error) {
      failed++;
      throw error;
    } finally {
      durations.push(clock() - begin);
    }
  };
  const metrics = () => {
    const sorted = [...durations].sort((a, b) => a - b);
    const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
    return { unit: 'milliseconds', scope: 'logical-rpc-including-adapter-retries',
      admitted, succeeded, failed, inFlight: admitted - succeeded - failed, budgetRejected,
      elapsedMs: clock() - started, completedCallMs: durations.reduce((sum, n) => sum + n, 0),
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: sorted.at(-1) ?? null,
      maxCalls, maxElapsedMs, percentileMethod: 'nearest-rank',
      networkAttempts: null, eventToCaptureMs: null };
  };
  return { rpc, metrics };
}
