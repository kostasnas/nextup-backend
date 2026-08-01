// tmdbThrottle.js
// A single, process-wide rate limiter that EVERY TMDB call goes
// through, no matter which user or which import job it belongs to.
// This exists purely so that many concurrent imports from different
// users share one coordinated budget instead of each independently
// hammering TMDB — NOT to slow down a single import. TMDB no longer
// publishes a hard rate limit (removed years ago for most endpoints),
// so this is set generously: high enough that a solo import runs at
// full speed, while still keeping a shared, centrally-enforced ceiling
// so a burst of simultaneous imports can't spike unbounded.
//
// This is an in-memory queue, which is fine as long as the backend
// runs as a single instance (true today on Render's free/Starter
// tier). If it's ever scaled to multiple instances, this would need
// to move to a shared store (e.g. Redis) to stay accurate.

const WINDOW_MS = 1_000;
const MAX_PER_WINDOW = 40;

let recentRequestTimestamps = [];
const queue = [];
let draining = false;

async function drainQueue() {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const now = Date.now();
    recentRequestTimestamps = recentRequestTimestamps.filter((t) => now - t < WINDOW_MS);

    if (recentRequestTimestamps.length >= MAX_PER_WINDOW) {
      const oldest = recentRequestTimestamps[0];
      const waitMs = WINDOW_MS - (now - oldest) + 50;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const job = queue.shift();
    recentRequestTimestamps.push(Date.now());
    try {
      job();
    } catch (err) {
      // A synchronous throw from job() (e.g. fn() wasn't actually async)
      // would otherwise reject this whole drainQueue() promise with
      // nothing downstream to catch it — the same unhandled-rejection
      // shape that took the server down before. job() itself already
      // routes normal async failures to the caller via reject(); this
      // is only a backstop for the synchronous-throw edge case.
      console.error("tmdbThrottle: job threw synchronously:", err.message);
    }
  }
  draining = false;
}

/**
 * Runs `fn` once there's room in the shared TMDB rate-limit window.
 * Use this to wrap every TMDB fetch, e.g.: throttle(() => fetch(url))
 */
function throttle(fn) {
  return new Promise((resolve, reject) => {
    queue.push(() => {
      fn().then(resolve).catch(reject);
    });
    drainQueue().catch((err) => {
      // Should be unreachable now that job() is guarded above, but a
      // fire-and-forget async call with no .catch is exactly the
      // pattern that caused the earlier crash — never leave one bare.
      console.error("tmdbThrottle: drainQueue failed:", err.message);
    });
  });
}

module.exports = { throttle };
