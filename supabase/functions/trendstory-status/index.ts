import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

// ---- CORS (단일 파일 배포를 위해 index.ts에 포함) ----
const corsHeaders: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
}

function handleOptions(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null
  return new Response('ok', { headers: corsHeaders })
}

// ---- Supabase client (단일 파일 배포를 위해 index.ts에 포함) ----
function getSupabaseClient(req: Request) {
  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!url) throw new Error('Missing secret: SUPABASE_URL')
  if (!anonKey) throw new Error('Missing secret: SUPABASE_ANON_KEY')

  const authHeader = req.headers.get('authorization') ?? ''

  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })
}

// ---- 최소 타입들 (단일 파일 배포를 위해 index.ts에 포함) ----
type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

type DbJobRow = {
  id: string
  created_at: string
  status: JobStatus
  input: unknown
  autoconfig: unknown | null
  packager: unknown | null
  final_package: unknown | null
  error: string | null
}

type DbSceneRow = {
  id: string
  job_id: string
  scene_id: number
  narration: string | null
  on_screen_text: string | null
  visual_brief: string | null
  mood: string | null
  duration_sec: number | null
  image_prompt: string | null
  image_path: string | null
  image_url: string | null
  image_gen_status?: string | null
  image_gen_request_id?: string | null
  image_gen_started_at?: string | null
  image_gen_error?: string | null
}

type DbAssetRow = {
  id: string
  job_id: string
  type: 'image' | 'audio' | 'json'
  path: string | null
  url: string | null
  meta: unknown | null
}

type TrendStoryStatusResponse = {
  trace_id?: string
  status: JobStatus
  job: DbJobRow
  scenes?: DbSceneRow[]
  assets?: DbAssetRow[]
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)

  const url = new URL(req.url)
  const jobId = url.searchParams.get('job_id') ?? ''
  if (!jobId) return json({ error: 'job_id is required' }, 400)

  const supabase = getSupabaseClient(req)

  const jobRes = await supabase
    .from('ytg_jobs')
    .select('id, created_at, status, input, autoconfig, packager, final_package, error, trace_id')
    .eq('id', jobId)
    .single()

  if (jobRes.error) {
    // not found or other errors
    const statusCode = jobRes.error.code === 'PGRST116' ? 404 : 500
    return json({ error: jobRes.error.message }, statusCode)
  }

  const scenesRes = await supabase
    .from('ytg_scenes')
    .select(
      'id, job_id, scene_id, narration, on_screen_text, visual_brief, mood, duration_sec, image_prompt, image_path, image_url, image_gen_status, image_gen_request_id, image_gen_started_at, image_gen_error',
    )
    .eq('job_id', jobId)
    .order('scene_id', { ascending: true })

  if (scenesRes.error) return json({ error: scenesRes.error.message }, 500)

  const assetsRes = await supabase
    .from('ytg_assets')
    .select('id, job_id, type, path, url, meta')
    .eq('job_id', jobId)

  if (assetsRes.error) return json({ error: assetsRes.error.message }, 500)

  const jobRow: DbJobRow = {
    id: jobRes.data.id,
    created_at: jobRes.data.created_at,
    status: jobRes.data.status,
    input: jobRes.data.input,
    autoconfig: jobRes.data.autoconfig,
    packager: jobRes.data.packager,
    final_package: jobRes.data.final_package,
    error: jobRes.data.error,
  }

  const res: TrendStoryStatusResponse = {
    trace_id: jobRes.data.trace_id,
    status: jobRes.data.status,
    job: jobRow,
    scenes: scenesRes.data ?? [],
    assets: assetsRes.data ?? [],
  }

  return json(res, 200)
})


