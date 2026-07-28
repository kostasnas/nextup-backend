// tmdbThrottle.js
// A single, process-wide rate limiter that EVERY TMDB call goes
// through, no matter which user or which import job it belongs to.
// TMDB's public limit is roughly 40 requests per 10 seconds — we stay
// comfortably under that, so if 10 people import at the same time,
// their requests just queue up smoothly instead of TMDB starting to
// reject them (which would otherwise make imports fail or hang).
//
// This is an in-memory queue, which is fine as long as the backend
// runs as a single instance (true today on Render's free/Starter
// tier). If it's ever scaled to multiple instances, this would need
// to move to a shared store (e.g. Redis) to stay accurate.

const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 35;

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
    job();
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
    drainQueue();
  });
}

module.exports = { throttle };
