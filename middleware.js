const ALLOW_METHODS = "GET,POST,OPTIONS";
const ALLOW_HEADERS = "content-type, authorization, idempotency-key";
const MAX_AGE = "86400";

function buildCorsHeaders(request) {
  const origin = request.headers.get("origin");
  const allowOrigin = !origin || origin === "null" ? "null" : origin;
  return {
    "access-control-allow-origin": allowOrigin,
    "vary": "origin",
    "access-control-allow-methods": ALLOW_METHODS,
    "access-control-allow-headers": ALLOW_HEADERS,
    "access-control-max-age": MAX_AGE,
  };
}

function applyHeaders(targetHeaders, sourceHeaders) {
  for (const [key, value] of Object.entries(sourceHeaders)) {
    if (key === "vary" && targetHeaders.has("vary")) {
      const existing = targetHeaders.get("vary") || "";
      const values = new Set(existing.split(",").map((s) => s.trim()).filter(Boolean));
      values.add(value);
      targetHeaders.set("vary", Array.from(values).join(", "));
    } else {
      targetHeaders.set(key, value);
    }
  }
}

export const config = { matcher: ["/api/:path*"] };

export default async function middleware(request) {
  const corsHeaders = buildCorsHeaders(request);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const response = await fetch(request);
  const headers = new Headers(response.headers);
  applyHeaders(headers, corsHeaders);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
