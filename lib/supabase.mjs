import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || "";
const ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

function buildClient(key, { persistSession = false } = {}) {
  if (!SUPABASE_URL || !key) return null;
  try {
    return createClient(SUPABASE_URL, key, { auth: { persistSession } });
  } catch (error) {
    console.error("supabase_client_init_failed", error?.message || error);
    return null;
  }
}

const memo = new Map();

function memoKey(kind, options = {}) {
  return `${kind}|persist:${options.persistSession === true}`;
}

export function getSupabaseAnon(options = {}) {
  const key = memoKey("anon", options);
  if (!memo.has(key)) memo.set(key, buildClient(ANON_KEY, options));
  return memo.get(key) || null;
}

export function getSupabaseServiceRole(options = {}) {
  const key = memoKey("service", options);
  if (!memo.has(key)) memo.set(key, buildClient(SERVICE_ROLE, options));
  return memo.get(key) || null;
}

export function resetSupabaseClients() {
  memo.clear();
}

export function ensureSupabaseClient(client, kind) {
  if (!client) {
    throw new Error(`missing_supabase_${kind || "client"}`);
  }
  return client;
}

export function getSupabaseEnv() {
  return {
    hasUrl: !!SUPABASE_URL,
    hasAnon: !!ANON_KEY,
    hasService: !!SERVICE_ROLE,
    url: SUPABASE_URL,
  };
}
