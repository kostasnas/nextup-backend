// Invite-a-friend: every user gets one short, random invite code (not their user id). The code goes into the Play
// Store link the app shares (&referrer=utm_source%3Dinvite%26utm_campaign%3D<code>), so the invited person's
// signup records it in acquisition.utm_campaign. After signup the app asks them whether to add the inviter as a friend.
const crypto = require("crypto");
const { getPool, getUserDisplayInfo } = require("./db");

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i, l, o, 0, 1)

function randomCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

async function getOrCreateInviteCode(userId) {
  const pool = getPool();
  const existing = await pool.query("select code from invite_codes where user_id = $1", [userId]);
  if (existing.rows[0]) return existing.rows[0].code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const r = await pool.query(
      "insert into invite_codes (user_id, code) values ($1, $2) on conflict do nothing returning code",
      [userId, code]
    );
    if (r.rows[0]) return r.rows[0].code;
    // Either the code collided or another request created this user's code first.
    const again = await pool.query("select code from invite_codes where user_id = $1", [userId]);
    if (again.rows[0]) return again.rows[0].code;
  }
  throw new Error("Could not create invite code");
}

// Who owns this code. Returns only what the invited person needs to see, never the id or email.
async function findInviterByCode(code) {
  if (!code || !/^[a-z0-9]{6,12}$/.test(code)) return null;
  const { rows } = await getPool().query("select user_id from invite_codes where code = $1", [code]);
  const userId = rows[0]?.user_id;
  if (!userId) return null;
  const info = await getUserDisplayInfo(userId);
  const prof = await getPool().query("select username from user_profiles where user_id = $1", [userId]);
  const username = prof.rows[0]?.username || null;
  const name = username || info?.display_name || null;
  if (!name) return null;
  return { id: userId, name };
}

module.exports = { getOrCreateInviteCode, findInviterByCode };
