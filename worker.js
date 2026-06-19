const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function handleGetCounts(env) {
  const { results } = await env.DB.prepare(
    "SELECT restaurant_key, COUNT(*) as count FROM comments GROUP BY restaurant_key"
  ).all();

  const counts = {};
  for (const row of results) counts[row.restaurant_key] = row.count;
  return json({ counts });
}

async function handleGetComments(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!key) return json({ error: "Missing restaurant key" }, 400);

  const { results } = await env.DB.prepare(
    "SELECT id, author, rating, body, created_at FROM comments WHERE restaurant_key = ? ORDER BY created_at DESC LIMIT 50"
  )
    .bind(key)
    .all();

  return json({ comments: results });
}

async function handlePostComment(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const { key, author, rating, body: text, honeypot } = body;

  // Honeypot — silently accept so bots don't know they were caught
  if (honeypot) return json({ ok: true });

  if (!key || typeof key !== "string") return json({ error: "Missing restaurant key" }, 400);
  if (!text || typeof text !== "string" || text.trim().length < 2)
    return json({ error: "Comment is too short" }, 400);
  if (text.length > 500) return json({ error: "Comment must be 500 characters or fewer" }, 400);

  const authorClean = ((author || "").toString().trim().slice(0, 80)) || "Anonymous";
  const ratingVal =
    rating != null ? Math.min(5, Math.max(1, parseInt(rating, 10))) : null;

  await env.DB.prepare(
    "INSERT INTO comments (restaurant_key, author, rating, body) VALUES (?, ?, ?, ?)"
  )
    .bind(key, authorClean, ratingVal, text.trim())
    .run();

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/comment-counts" && request.method === "GET") {
      return handleGetCounts(env);
    }

    if (url.pathname === "/api/comments") {
      if (request.method === "GET") return handleGetComments(url, env);
      if (request.method === "POST") return handlePostComment(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
