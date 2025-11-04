import { NextResponse } from "next/server";

export function middleware(req: Request) {
  const res = NextResponse.next();
  const origin = req.headers.get("origin");
  const allow = !origin || origin === "null" ? "null" : origin;

  res.headers.set("access-control-allow-origin", allow);
  res.headers.set("vary", "origin");
  res.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  res.headers.set("access-control-allow-headers", "content-type, authorization, idempotency-key");
  res.headers.set("access-control-max-age", "86400");
  return res;
}

export const config = { matcher: ["/api/:path*"] };
