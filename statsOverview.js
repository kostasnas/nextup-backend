// Aggregates for the Stats screen (GET /stats/overview). Pure function over
// the rows from db.getStatsRows so it is easy to test.
const DAY = 86400000;

function isDated(row, firstImport) {
  if (!row.watched_at) return false;
  if (row.source === "import_tvtime") return false; // count-based: no real dates
  if (firstImport && String(row.source || "").startsWith("import")) {
    // stamped "now" by the importer when the file had no date
    if (new Date(row.watched_at).getTime() >= new Date(firstImport).getTime() - 3600000) return false;
  }
  return true;
}

const dayKey = (d) => d.toISOString().slice(0, 10);

const EMOTIONS = new Set(["loved", "funny", "shocked", "sad", "mad", "mindblown"]);

function buildOverview({ eps, movies, reactions = [], firstImport }, now = new Date()) {
  const episodeMinutes = eps.reduce((n, r) => n + Number(r.rt), 0);
  const movieMinutes = movies.reduce((n, m) => n + Number(m.runtime || 0), 0);
  const totalMinutes = episodeMinutes + movieMinutes;

  // Top shows by time watched
  const byShow = new Map();
  for (const r of eps) {
    const s = byShow.get(r.show_id) || { genres: r.genres, year: r.first_air_year, title: r.title, posterPath: r.poster_path, network: r.network, episodes: 0, minutes: 0 };
    s.episodes += 1; s.minutes += Number(r.rt);
    byShow.set(r.show_id, s);
  }
  const topShows = [...byShow.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5)
    .map((s) => ({ title: s.title, posterPath: s.posterPath, episodes: s.episodes, hours: Math.round(s.minutes / 6) / 10 }));

  // Networks, counted per distinct show
  const net = new Map();
  for (const s of byShow.values()) if (s.network) net.set(s.network, (net.get(s.network) || 0) + 1);
  const networks = [...net.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, shows]) => ({ name, shows }));

  // Genres (distinct shows per genre) and decades (shows + movies)
  const gc = new Map();
  for (const s of byShow.values()) for (const g of s.genres || []) gc.set(g, (gc.get(g) || 0) + 1);
  const genres = [...gc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
  const dc = new Map();
  const bump = (y) => { if (y) { const d = Math.floor(y / 10) * 10; dc.set(d, (dc.get(d) || 0) + 1); } };
  for (const s of byShow.values()) bump(s.year);
  for (const m of movies) bump(m.year);
  const decades = [...dc.entries()].sort((a, b) => a[0] - b[0]).map(([decade, count]) => ({ decade, count }));

  // Dated activity only
  const dated = eps.filter((r) => isDated(r, firstImport)).map((r) => ({ t: new Date(r.watched_at), show: r.show_id, title: r.title, rt: Number(r.rt) }));
  const t7 = now.getTime() - 7 * DAY, t30 = now.getTime() - 30 * DAY, t60 = now.getTime() - 60 * DAY;
  const win = (from, to) => dated.filter((d) => d.t.getTime() >= from && d.t.getTime() < to);
  const sum = (a) => a.reduce((n, d) => n + d.rt, 0);
  const last7 = win(t7, Infinity), last30 = win(t30, Infinity), prev30 = win(t60, t30);

  const days = new Map(); // yyyy-mm-dd -> plays
  const months = new Map(); // yyyy-mm -> minutes
  const bingeKey = new Map(); // day|show -> {n,title}
  for (const d of dated) {
    const k = dayKey(d.t);
    days.set(k, (days.get(k) || 0) + 1);
    const mk = k.slice(0, 7);
    months.set(mk, (months.get(mk) || 0) + d.rt);
    const bk = k + "|" + d.show;
    const b = bingeKey.get(bk) || { n: 0, title: d.title, day: k };
    b.n += 1; bingeKey.set(bk, b);
  }
  const biggestBinge = [...bingeKey.values()].sort((a, b) => b.n - a.n)[0] || null;
  const bestMonthE = [...months.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  // Longest streak of consecutive days
  const keys = [...days.keys()].sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    const cur = new Date(k + "T00:00:00Z").getTime();
    run = prev !== null && cur - prev === DAY ? run + 1 : 1;
    if (run > best) best = run;
    prev = cur;
  }

  // Last 52 weeks (Mon-start) of plays, last ~22 weeks of daily cells
  const weeks = [], weekMinutes = [];
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  for (let w = 51; w >= 0; w--) {
    const from = monday.getTime() - w * 7 * DAY;
    const inWeek = win(from, from + 7 * DAY);
    weeks.push(inWeek.length);
    weekMinutes.push(Math.round(sum(inWeek)));
  }
  const heat = [];
  for (let i = 153; i >= 0; i--) heat.push(days.get(dayKey(new Date(now.getTime() - i * DAY))) || 0);

  const earliest = dated.reduce((m, d) => (!m || d.t < m.t ? d : m), null);
  const pace30Minutes = sum(last30) / 30;

  return {
    totalMinutes,
    episodes: eps.length,
    movies: movies.length,
    seriesShare: totalMinutes > 0 ? Math.round((episodeMinutes / totalMinutes) * 100) : null,
    topShows, networks, genres, decades, showsCount: byShow.size,
    datedEpisodes: dated.length,
    last7: { minutes: Math.round(sum(last7)), plays: last7.length },
    last30: { minutes: Math.round(sum(last30)), plays: last30.length },
    prev30Minutes: Math.round(sum(prev30)),
    paceMinutesPerDay: Math.round(pace30Minutes),
    weeks, weekMinutes, heat,
    emotions: reactions.filter((r) => EMOTIONS.has(r.reaction)).map((r) => ({ key: r.reaction, count: r.count })).sort((a, b) => b.count - a.count),
    hallOfFame: {
      biggestBinge: biggestBinge && biggestBinge.n >= 2 ? { episodes: biggestBinge.n, day: biggestBinge.day, title: biggestBinge.title } : null,
      bestMonth: bestMonthE ? { month: bestMonthE[0], minutes: Math.round(bestMonthE[1]) } : null,
      longestStreak: best,
      watchingSince: earliest ? { date: dayKey(earliest.t), title: earliest.title } : null,
    },
  };
}

// "My year on screen" card (GET /stats/year?year=2026): the person's own totals for one calendar year.
// Only episodes with a real watch date inside that year count (see isDated: count-based and "stamped now"
// import rows have no real date, so they never inflate a year). Movies have no source column, so a movie
// whose watched_at falls inside the importer's first run (first_import -1h .. +24h) is treated as undated
// too; a movie logged by hand any other time counts. Pure function, like buildOverview.
const YEAR_TOP = 12; // how many "My year" posters the picker can offer
const MIN_EPISODES_FOR_CARD = 10;

function buildYear({ eps, movies, firstImport }, year, now = new Date()) {
  const inYear = (d) => d && !Number.isNaN(d.getTime()) && d.getUTCFullYear() === year;
  const dated = eps
    .filter((r) => isDated(r, firstImport))
    .map((r) => ({ t: new Date(r.watched_at), r }))
    .filter((x) => inYear(x.t));

  const importFrom = firstImport ? new Date(firstImport).getTime() - 3600000 : null;
  const importTo = firstImport ? new Date(firstImport).getTime() + DAY : null;
  const yearMovies = movies.filter((m) => {
    if (!m.watched_at) return false;
    const t = new Date(m.watched_at);
    if (!inYear(t)) return false;
    if (importFrom !== null && t.getTime() >= importFrom && t.getTime() <= importTo) return false;
    return true;
  });

  const episodeMinutes = dated.reduce((n, x) => n + Number(x.r.rt), 0);
  const movieMinutes = yearMovies.reduce((n, m) => n + Number(m.runtime || 0), 0);

  const byShow = new Map();
  for (const { t, r } of dated) {
    const s = byShow.get(r.show_id) || { title: r.title, posterPath: r.poster_path, genres: r.genres, episodes: 0, minutes: 0, last: 0 };
    s.episodes += 1; s.minutes += Number(r.rt); s.last = Math.max(s.last, t.getTime());
    byShow.set(r.show_id, s);
  }
  // Most time first; ties: more episodes, then watched most recently.
  const ranked = [...byShow.values()].sort((a, b) => b.minutes - a.minutes || b.episodes - a.episodes || b.last - a.last);
  const topShows = ranked.filter((s) => s.posterPath).slice(0, YEAR_TOP)
    .map((s) => ({ title: s.title, posterPath: s.posterPath, episodes: s.episodes, hours: Math.round(s.minutes / 6) / 10 }));

  // Genre = the one with the most distinct shows this year (ties: the one met first in the ranking).
  const gc = new Map();
  for (const s of ranked) for (const g of s.genres || []) gc.set(g, (gc.get(g) || 0) + 1);
  const topGenre = [...gc.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const months = new Map(); // yyyy-mm -> minutes
  for (const { t, r } of dated) {
    const k = t.toISOString().slice(0, 7);
    months.set(k, (months.get(k) || 0) + Number(r.rt));
  }
  for (const m of yearMovies) {
    const k = new Date(m.watched_at).toISOString().slice(0, 7);
    months.set(k, (months.get(k) || 0) + Number(m.runtime || 0));
  }
  const busiest = [...months.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] || null;

  return {
    year,
    episodes: dated.length,
    shows: byShow.size,
    movies: yearMovies.length,
    totalMinutes: Math.round(episodeMinutes + movieMinutes),
    topShows,
    mostWatched: ranked[0]?.title || null,
    topGenre,
    busiestMonth: busiest ? busiest[0] : null, // "2026-10"
    eligible: dated.length >= MIN_EPISODES_FOR_CARD,
    minEpisodes: MIN_EPISODES_FOR_CARD,
  };
}

module.exports = { buildOverview, buildYear, isDated };
