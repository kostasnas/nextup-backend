// concurrency.js
// Runs `fn` over `items` with at most `limit` in flight at once. Used by the importers so
// thousands of movies aren't processed one network round trip at a time (a 5,000-movie
// import took ~16 minutes sequentially). The shared TMDB throttle still caps TMDB calls.
async function forEachConcurrent(items, limit, fn) {
  const list = Array.from(items || []);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  });
  await Promise.all(workers);
}

module.exports = { forEachConcurrent };
