// commsModeration.js
// Pre-send moderation for comments headed to the shared CommsUni board.
// CommsUni does not filter partner writes, so everything a Scenera user posts is
// checked here first: cheap local rules, then a Groq model classification.
// Local rules always apply. If the model call itself fails we fall back to the
// local rules only (and log it) rather than blocking everyone during an outage.

const MAX_LEN = 2000;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const URL_RE = /(https?:\/\/|www\.)\S+/gi;

function localCheck(text) {
  if (typeof text !== "string") return { ok: false, reason: "Write something first." };
  const t = text.trim();
  if (!t) return { ok: false, reason: "Write something first." };
  if (t.length > MAX_LEN) return { ok: false, reason: `Comments can be up to ${MAX_LEN} characters.` };
  if (CONTROL_RE.test(t)) return { ok: false, reason: "That comment contains characters we can't post." };
  const urls = t.match(URL_RE) || [];
  if (urls.length > 1) return { ok: false, reason: "Please keep it to one link at most." };
  if (/(.)\1{14,}/u.test(t)) return { ok: false, reason: "That looks like spam — try writing it differently." };
  return { ok: true, text: t };
}

async function modelCheck(text) {
  if (!process.env.GROQ_API_KEY) return { ok: true, skipped: true };
  const system =
    "You moderate comments about TV shows and movies for a public board that includes teenagers and adults. " +
    "Reject a comment only if it contains: hate speech or slurs aimed at people, harassment or threats, sexual content involving minors or explicit sexual content, " +
    "doxxing or personal data (phone numbers, addresses, emails), advertising/spam/scam links, or illegal piracy links. " +
    "Strong opinions, swearing used casually, criticism of shows or actors, and spoilers are ALLOWED. The comment may be in any language. " +
    'Also detect the main language of the comment as a plain ISO 639-1 code (en, it, pt, el...), or "unknown" if it is only emoji, names or too short to tell. ' +
    'Reply with JSON only: {"allow": true|false, "reason": "short category", "language": "xx"}.';
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [{ role: "system", content: system }, { role: "user", content: text }],
        temperature: 0,
        max_tokens: 800, // this model spends part of the budget on reasoning before the JSON
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    if (typeof parsed.allow !== "boolean") throw new Error("unexpected moderation reply");
    const lang = typeof parsed.language === "string" && /^[a-z]{2,3}$/i.test(parsed.language) && parsed.language.toLowerCase() !== "unknown" ? parsed.language.toLowerCase() : null;
    return { ok: parsed.allow, reason: parsed.reason, language: lang };
  } catch (e) {
    console.error("Comment moderation model unavailable, using local rules only:", e.message);
    return { ok: true, skipped: true };
  }
}

// Image check for the shared board. Unlike text, an image we can't check is NOT
// let through: the board is public and CommsUni does not filter partner writes.
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
async function moderateImage(url) {
  if (!process.env.GROQ_API_KEY) return { ok: false, unavailable: true };
  const system =
    "You moderate images attached to comments about TV shows and movies on a public board that includes teenagers. " +
    "Reject an image only if it shows: nudity or sexual content, graphic gore or real violence, anything involving minors in a sexual context, hate symbols, " +
    "or readable personal data (IDs, cards, addresses, phone numbers). Screenshots and stills from shows and films, memes, reaction images, fan art and ordinary photos are ALLOWED, including fictional violence. " +
    'Reply with JSON only: {"allow": true|false, "reason": "short category"}.';
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: [{ type: "text", text: "Moderate this image." }, { type: "image_url", image_url: { url } }] },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    if (typeof parsed.allow !== "boolean") throw new Error("unexpected moderation reply");
    return { ok: parsed.allow, reason: parsed.reason };
  } catch (e) {
    console.error("Image moderation unavailable, refusing the image:", e.message);
    return { ok: false, unavailable: true };
  }
}

/** Returns { ok: true, text } or { ok: false, reason } (reason is safe to show the user). */
async function moderateComment(text) {
  const local = localCheck(text);
  if (!local.ok) return local;
  const model = await modelCheck(local.text);
  if (!model.ok) {
    console.warn("Comment blocked by moderation:", model.reason || "unspecified");
    return { ok: false, reason: "That comment can't be posted because it may break our community rules." };
  }
  return { ok: true, text: local.text, language: model.language || null };
}

module.exports = { moderateComment, moderateImage, localCheck, MAX_LEN };
