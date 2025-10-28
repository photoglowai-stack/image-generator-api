const DEFAULT_METHODS = "GET,POST,OPTIONS,HEAD";
const DEFAULT_HEADERS = "content-type, authorization, idempotency-key, x-admin-token";

export function setCORS(req, res, options = {}) {
  const allowNull = (process.env.ALLOW_NULL_ORIGIN ?? "true") === "true";
  const reqOrigin = req?.headers?.origin ?? null;
  const front = process.env.FRONT_ORIGIN || "*";
  const allowOrigin = allowNull && (reqOrigin === "null" || reqOrigin === null) ? "null" : front;

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", options.allowMethods || DEFAULT_METHODS);
  res.setHeader("Access-Control-Allow-Headers", options.allowHeaders || DEFAULT_HEADERS);
  res.setHeader("Access-Control-Max-Age", String(options.maxAge ?? 86400));
}

export function createInMemoryResponse() {
  const headers = new Map();
  let statusCode = 200;
  let resolveFn;
  const resultPromise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const res = {
    status(code) {
      if (typeof code === "number") statusCode = code;
      return this;
    },
    setHeader(name, value) {
      if (typeof name === "string") headers.set(name, value);
    },
    getHeader(name) {
      return headers.get(name);
    },
    json(payload) {
      resolveFn({ statusCode, payload, headers });
      return this;
    },
    end(payload) {
      resolveFn({ statusCode, payload: payload ?? null, headers });
      return this;
    },
  };

  return { res, result: resultPromise };
}
