// @ts-nocheck
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

function handleOptions(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders })
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

function requireEnv(name: string) {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

function getSupabaseServiceClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey)
}

type DeleteJobRequest = {
  job_id: string
}

type DeleteJobResponse = {
  job_id: string
  accepted: boolean
  message: string
}

async function deleteStoragePrefix(bucket: string, prefix: string) {
  const supabase = getSupabaseServiceClient()

  // list is not recursive; we delete common known files under jobs/<job_id> plus best-effort list
  const toRemove: string[] = []

  // best-effort listing (single level)
  const listRes = await supabase.storage.from(bucket).list(prefix, { limit: 100, offset: 0 })
  if (!listRes.error) {
    for (const obj of listRes.data ?? []) {
      if (obj?.name) toRemove.push(`${prefix}/${obj.name}`.replace(/\/{2,}/g, '/'))
    }
  }

  // also attempt known paths
  toRemove.push(`${prefix}/narration.mp3`)

  // de-dup
  const unique = Array.from(new Set(toRemove))
  if (unique.length === 0) return

  await supabase.storage.from(bucket).remove(unique)
}

async function runDeleteJob(jobId: string) {
  const supabase = getSupabaseServiceClient()
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  // 1) delete storage objects (best-effort)
  try {
    await deleteStoragePrefix(bucket, `jobs/${jobId}`)
  } catch {
    // ignore (do not block job deletion)
  }

  // 2) delete DB row (cascades scenes/assets)
  await supabase.from('ytg_jobs').delete().eq('id', jobId)
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let payload: DeleteJobRequest
  try {
    payload = (await req.json()) as DeleteJobRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const jobId = String(payload?.job_id ?? '').trim()
  if (!jobId) return json({ error: 'job_id is required' }, 400)

  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil
  if (typeof waitUntil === 'function') {
    waitUntil(runDeleteJob(jobId))
  } else {
    runDeleteJob(jobId)
  }

  const out: DeleteJobResponse = {
    job_id: jobId,
    accepted: true,
    message: '삭제를 백그라운드로 시작했습니다. 잠시 후 목록에서 사라집니다.',
  }
  return json(out, 202)
})



