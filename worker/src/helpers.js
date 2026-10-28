export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const now = () => Date.now();

const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) {
    b = { start: t, count: 0 };
    buckets.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}
