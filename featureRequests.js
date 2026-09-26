// featureRequests.js
// A simple in-app "suggest a feature" board: any signed-in user can
// post an idea and upvote existing ones, ranked by vote count. Kostas
// moves a request's status (open -> planned -> shipped / declined)
// directly in Supabase's table editor — no separate admin UI needed.

async function listFeatureRequests(supabase, userId) {
  const { data: requests, error } = await supabase
    .from("feature_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: votes, error: votesError } = await supabase
    .from("feature_request_votes")
    .select("feature_request_id, user_id");
  if (votesError) throw votesError;

  const voteCounts = {};
  const myVotes = new Set();
  for (const v of votes || []) {
    voteCounts[v.feature_request_id] = (voteCounts[v.feature_request_id] || 0) + 1;
    if (v.user_id === userId) myVotes.add(v.feature_request_id);
  }

  const enriched = (requests || []).map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    isMine: r.user_id === userId,
    voteCount: voteCounts[r.id] || 0,
    votedByMe: myVotes.has(r.id),
  }));

  // Open/planned requests first (ranked by votes) — shipped/declined
  // sink to the bottom since they're no longer actionable, but stay
  // visible so people can see what's already been done.
  const ACTIVE_STATUSES = new Set(["open", "planned"]);
  enriched.sort((a, b) => {
    const aActive = ACTIVE_STATUSES.has(a.status) ? 0 : 1;
    const bActive = ACTIVE_STATUSES.has(b.status) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.voteCount - a.voteCount;
  });

  return enriched;
}

async function createFeatureRequest(supabase, userId, title, description) {
  const { data, error } = await supabase
    .from("feature_requests")
    .insert({ user_id: userId, title, description: description || null })
    .select()
    .single();
  if (error) throw error;

  // Auto-vote your own suggestion, same as every similar board (Canny,
  // etc.) — otherwise it'd sit at 0 votes right after posting it.
  const { error: voteError } = await supabase
    .from("feature_request_votes")
    .insert({ feature_request_id: data.id, user_id: userId });
  if (voteError) throw voteError;

  return {
    id: data.id,
    title: data.title,
    description: data.description,
    status: data.status,
    createdAt: data.created_at,
    isMine: true,
    voteCount: 1,
    votedByMe: true,
  };
}

async function toggleVote(supabase, userId, requestId) {
  const { data: existing, error: findError } = await supabase
    .from("feature_request_votes")
    .select("user_id")
    .eq("feature_request_id", requestId)
    .eq("user_id", userId)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { error } = await supabase
      .from("feature_request_votes")
      .delete()
      .eq("feature_request_id", requestId)
      .eq("user_id", userId);
    if (error) throw error;
    return { voted: false };
  }

  const { error } = await supabase
    .from("feature_request_votes")
    .insert({ feature_request_id: requestId, user_id: userId });
  if (error) throw error;
  return { voted: true };
}

module.exports = { listFeatureRequests, createFeatureRequest, toggleVote };
