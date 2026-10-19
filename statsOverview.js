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

function buildOverview({ eps, movies, firstImport }, now = new Date()) {
  const episodeMinutes = eps.reduce((n, r) => n + Number(r.rt), 0);
  const movieMinutes = movies.reduce((n, m) => n + Number(m.runtime || 0), 0);
  const totalMinutes = episodeMinutes + movieMinutes;

  // Top shows by time watched
  const byShow = new Map();
  for (const r of eps) {
    const s = byShow.get(r.show_id) || { title: r.title, posterPath: r.poster_path, network: r.network, episodes: 0, minutes: 0 };
    s.episodes += 1; s.minutes += Number(r.rt);
    byShow.set(r.show_id, s);
  }
  const topShows = [...byShow.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5)
    .map((s) => ({ title: s.title, posterPath: s.posterPath, episodes: s.episodes, hours: Math.round(s.minutes / 6) / 10 }));

  // Networks, counted per distinct show
  const net = new Map();
  for (const s of byShow.values()) if (s.network) net.set(s.network, (net.get(s.network) || 0) + 1);
  const networks = [...net.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, shows]) => ({ name, shows }));

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
  const weeks = [];
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  for (let w = 51; w >= 0; w--) {
    const from = monday.getTime() - w * 7 * DAY;
    weeks.push(win(from, from + 7 * DAY).length);
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
    topShows, networks, showsCount: byShow.size,
    datedEpisodes: dated.length,
    last7: { minutes: Math.round(sum(last7)), plays: last7.length },
    last30: { minutes: Math.round(sum(last30)), plays: last30.length },
    prev30Minutes: Math.round(sum(prev30)),
    paceMinutesPerDay: Math.round(pace30Minutes),
    weeks, heat,
    hallOfFame: {
      biggestBinge: biggestBinge && biggestBinge.n >= 2 ? { episodes: biggestBinge.n, day: biggestBinge.day, title: biggestBinge.title } : null,
      bestMonth: bestMonthE ? { month: bestMonthE[0], minutes: Math.round(bestMonthE[1]) } : null,
      longestStreak: best,
      watchingSince: earliest ? { date: dayKey(earliest.t), title: earliest.title } : null,
    },
  };
}

module.exports = { buildOverview, isDated };
