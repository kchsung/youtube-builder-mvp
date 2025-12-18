// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

// ---- CORS (단일 파일 배포를 위해 index.ts에 포함) ----
const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, OPTIONS',
}

function handleOptions(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders })
}

function requireEnv(name: string) {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

function getSupabaseAnonClient(req: Request) {
  const url = requireEnv('SUPABASE_URL')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')
  const authHeader = req.headers.get('authorization') ?? ''
  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

type JobListItem = {
  id: string
  created_at: string
  status: JobStatus
  trace_id: string
  input: unknown
  error: string | null
}

type TrendStoryJobsResponse = {
  jobs: JobListItem[]
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  const url = new URL(req.url)
  const limitRaw = url.searchParams.get('limit') ?? '20'
  const limit = Math.max(1, Math.min(Number(limitRaw) || 20, 50))

  const supabase = getSupabaseAnonClient(req)
  const res = await supabase
    .from('ytg_jobs')
    .select('id, created_at, status, trace_id, input, error')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (res.error) return json({ error: res.error.message }, 500)

  const body: TrendStoryJobsResponse = { jobs: (res.data ?? []) as JobListItem[] }
  return json(body, 200)
})


