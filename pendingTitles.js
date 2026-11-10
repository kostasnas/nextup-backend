// pendingTitles.js
// Imports leave behind titles TMDB does not have yet (mostly unreleased films and shows a person kept
// on a "planned" list elsewhere). They are saved per person here, and once a week we look again: when
// TMDB has a title by then it is added to the person's Planned list and they get a notification.
//
// Safe by design: only an EXACT title match (and the same year, when the import gave one) is accepted,
// so a similar-sounding title never lands on someone's list by mistake; and a title the person already
// has in their lists is never touched, only closed quietly.
// Needs migrations/pending_titles.sql; until the table exists everything here just logs and skips.
const RETRY_AFTER_MS = 6 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;
const GIVE_UP_AFTER_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const norm = (t) => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const yearOf = (d) => (d && /^\d{4}/.test(d) ? parseInt(d.slice(0, 4), 10) : null);

// Called after every import with its result. Shows come from the unmatched rows the matcher wrote for
// the job (import_unmatched) and from result.unmatchedShowTitles (sources that skip shows themselves).
async function savePendingTitles(supabase, userId, source, result) {
  if (!userId) return;
  const wanted = new Map(); // `${kind}|${title}|${year}` -> row
  const add = (kind, title, year) => {
    const t = String(title || "").trim().slice(0, 300);
    if (!t) return;
    const y = Number.isInteger(year) ? year : null;
    wanted.set(`${kind}|${norm(t)}|${y ?? 0}`, { user_id: userId, kind, title: t, year: y, source: String(source || "").slice(0, 40) });
  };
  for (const m of (result?.unmatchedMovies || []).slice(0, 1000)) add("movie", m.title, m.year);
  for (const t of (result?.unmatchedShowTitles || []).slice(0, 1000)) add("show", typeof t === "string" ? t : t?.title, typeof t === "string" ? null : t?.year);
  if (result?.jobId) {
    const { data } = await supabase.from("import_unmatched").select("raw_title").eq("import_job_id", result.jobId).eq("resolved", false).limit(1000);
    for (const r of data || []) add("show", r.raw_title, null);
  }
  if (wanted.size === 0) return;
  const { data: existing, error: exErr } = await supabase.from("pending_titles").select("kind, title, year").eq("user_id", userId).is("resolved_at", null);
  if (exErr) { console.error("Saving pending titles failed (is the pending_titles table created?):", exErr.message); return; }
  for (const e of existing || []) wanted.delete(`${e.kind}|${norm(e.title)}|${e.year ?? 0}`);
  const rows = [...wanted.values()];
  if (rows.length === 0) return;
  const { error } = await supabase.from("pending_titles").insert(rows);
  if (error) console.error("Saving pending titles failed:", error.message);
}

function mountPendingTitles({ supabase, sendPushToUser, searchMovie, searchShow, forEachConcurrent }) {
  let running = false;

  async function addMovie(row, hit) {
    const { data: movie } = await supabase.from("movies").select("id").eq("tmdb_id", hit.id).maybeSingle();
    let movieId = movie?.id;
    if (!movieId) {
      const { data: ins, error } = await supabase
        .from("movies")
        .insert({ tmdb_id: hit.id, title: hit.title, poster_path: hit.poster_path || null, release_date: hit.release_date || null, overview: hit.overview || null })
        .select("id")
        .single();
      if (error) throw error;
      movieId = ins.id;
    }
    const { data: has } = await supabase.from("user_movie_watchlist").select("movie_id").eq("user_id", row.user_id).eq("movie_id", movieId).maybeSingle();
    if (has) return false; // already on their list: nothing to add, nothing to announce
    const { error } = await supabase.from("user_movie_watchlist").insert({ user_id: row.user_id, movie_id: movieId, status: "planned", updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  }

  async function addShow(row, hit) {
    const { data: show } = await supabase.from("shows").select("id").eq("tmdb_id", hit.id).maybeSingle();
    let showId = show?.id;
    if (!showId) {
      const { data: ins, error } = await supabase.from("shows").insert({ tmdb_id: hit.id, title: hit.name, poster_path: hit.poster_path || null }).select("id").single();
      if (error) throw error;
      showId = ins.id;
    }
    const { data: has } = await supabase.from("user_watchlist").select("show_id").eq("user_id", row.user_id).eq("show_id", showId).maybeSingle();
    if (has) return false;
    const { error } = await supabase.from("user_watchlist").insert({ user_id: row.user_id, show_id: showId, status: "planned", updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  }

  async function tryOne(row) {
    const results = row.kind === "movie" ? await searchMovie(row.title) : await searchShow(row.title);
    const hit = (results || []).find((r) => {
      const name = row.kind === "movie" ? r.title : r.name;
      const original = row.kind === "movie" ? r.original_title : r.original_name;
      if (norm(name) !== norm(row.title) && norm(original) !== norm(row.title)) return false;
      if (!row.year) return true;
      return yearOf(row.kind === "movie" ? r.release_date : r.first_air_date) === row.year;
    });
    if (!hit) return null;
    const added = row.kind === "movie" ? await addMovie(row, hit) : await addShow(row, hit);
    return { added, name: row.kind === "movie" ? hit.title : hit.name };
  }

  async function sweep() {
    if (running) return { skipped: true };
    running = true;
    const out = { checked: 0, added: 0, closed: 0, failed: 0 };
    try {
      const cutoff = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
      const { data: rows, error } = await supabase
        .from("pending_titles")
        .select("*")
        .is("resolved_at", null)
        .or(`last_attempt_at.is.null,last_attempt_at.lt.${cutoff}`)
        .order("created_at", { ascending: true })
        .limit(BATCH);
      if (error) { console.error("pending titles sweep: read failed:", error.message); return out; }
      await forEachConcurrent(rows || [], 3, async (row) => {
        out.checked++;
        const now = new Date().toISOString();
        try {
          const found = await tryOne(row);
          if (!found) {
            const tooOld = Date.now() - new Date(row.created_at).getTime() > GIVE_UP_AFTER_MS;
            await supabase.from("pending_titles").update({ last_attempt_at: now, attempts: (row.attempts || 0) + 1, ...(tooOld ? { resolved_at: now, resolved_note: "gave up" } : {}) }).eq("id", row.id);
            if (tooOld) out.closed++;
            return;
          }
          await supabase.from("pending_titles").update({ last_attempt_at: now, attempts: (row.attempts || 0) + 1, resolved_at: now, resolved_note: found.added ? "added" : "already on list" }).eq("id", row.id);
          if (found.added) {
            out.added++;
            Promise.resolve(sendPushToUser(supabase, row.user_id, {
              title: "Added to your Planned list",
              body: `${found.name} is now available, so we added it to your Planned list. You didn't lose it.`,
              data: { type: "pending_title_added", kind: row.kind },
            })).catch((e) => console.error("pending titles push failed:", e.message));
          } else out.closed++;
        } catch (e) {
          out.failed++;
          console.error(`pending titles: "${row.title}" failed:`, e.message);
          await supabase.from("pending_titles").update({ last_attempt_at: now, attempts: (row.attempts || 0) + 1 }).eq("id", row.id);
        }
      });
    } catch (e) {
      console.error("pending titles sweep failed:", e.message);
    } finally {
      running = false;
    }
    if (out.checked) console.log(`pending titles sweep: checked ${out.checked}, added ${out.added}, closed ${out.closed}, failed ${out.failed}`);
    return out;
  }

  if (process.env.NODE_ENV !== "test") {
    setTimeout(sweep, 10 * 60 * 1000).unref();
    setInterval(sweep, SWEEP_EVERY_MS).unref();
  }
  return { sweep };
}

module.exports = { savePendingTitles, mountPendingTitles, norm };
