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

function pickJwtKey(keys: Array<string | null | undefined>) {
  for (const k of keys) {
    const t = (k ?? '').trim()
    if (!t) continue
    if (t.split('.').length >= 3) return t
  }
  // fallback: return first non-empty (even if misconfigured) for logging
  for (const k of keys) {
    const t = (k ?? '').trim()
    if (t) return t
  }
  return ''
}

function buildEdgeFunctionAuthHeaders(key: string) {
  const t = (key ?? '').trim()
  if (!t) return { ok: false, headers: { 'content-type': 'application/json' } as Record<string, string>, jwtLike: false }
  const jwtLike = t.split('.').length >= 3
  // NOTE:
  // - verify_jwt=true(기본)인 함수는 Authorization: Bearer <JWT>가 필요합니다.
  // - 새 키 체계(sbp_/sbs_ 등)처럼 JWT가 아닌 키를 쓰는 경우 verify_jwt=false로 배포해야 합니다.
  const headers: Record<string, string> = { apikey: t, 'content-type': 'application/json' }
  if (jwtLike) headers.Authorization = `Bearer ${t}`
  return { ok: true, headers, jwtLike }
}

function getSupabaseServiceClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey)
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

function sleepMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function openaiImagePng(prompt: string): Promise<Uint8Array> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const imageModel = (Deno.env.get('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1-mini').trim() || 'gpt-image-1-mini'
  const envSize = Deno.env.get('OPENAI_IMAGE_SIZE')?.trim()
  const sizes = Array.from(new Set([envSize, '1792x1024', '1024x1024'].filter(Boolean))) as string[]
  // "2분 무응답이면 재시도" 요구사항: 기본 타임아웃을 120초로 둡니다(환경변수로 override 가능).
  const timeoutMs = Number(Deno.env.get('OPENAI_IMAGE_TIMEOUT_MS') ?? '120000') || 120000
  const maxAttemptsPerSize = Math.max(1, Math.min(Number(Deno.env.get('OPENAI_IMAGE_MAX_ATTEMPTS') ?? '2') || 2, 5))

  let lastErr: unknown = null
  for (const size of sizes) {
    for (let attempt = 1; attempt <= maxAttemptsPerSize; attempt++) {
      let res: Response
      let text: string
      try {
        res = await fetchWithTimeout(
          'https://api.openai.com/v1/images/generations',
          {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model: imageModel, prompt, size }),
          },
          timeoutMs,
        )
        text = await res.text()
      } catch (e: any) {
        const msg = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e)
        lastErr = new Error(`OpenAI image request failed (${size}, attempt ${attempt}): ${msg}`)
        await sleepMs(600 * attempt)
        continue
      }

      if (!res.ok) {
        lastErr = new Error(`OpenAI image error (${res.status}, size=${size}, attempt=${attempt}): ${text}`)
        if (res.status === 400) break
        if (res.status === 429 || res.status >= 500) {
          await sleepMs(800 * attempt)
          continue
        }
        throw lastErr
      }

      const json = JSON.parse(text)
      const first = json?.data?.[0]
      const b64: string | undefined = first?.b64_json
      if (b64) {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return bytes
      }
      const url: string | undefined = first?.url
      if (url) {
        const imgRes = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs)
        if (!imgRes.ok) throw new Error(`Failed to fetch image URL (${imgRes.status})`)
        const ab = await imgRes.arrayBuffer()
        return new Uint8Array(ab)
      }
      lastErr = new Error('OpenAI image returned neither b64_json nor url')
      await sleepMs(400 * attempt)
    }
  }

  throw lastErr ?? new Error('OpenAI image error: no valid size worked')
}

function safeFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function nowIso() {
  return new Date().toISOString()
}

function ensureRuntime(packager: any) {
  if (!packager) return null
  if (!packager._runtime) packager._runtime = {}
  if (!packager._runtime.logs) packager._runtime.logs = []
  return packager._runtime
}

function pushRuntimeLog(packager: any, level: 'info' | 'warn' | 'error', msg: string, data?: unknown) {
  const rt = ensureRuntime(packager)
  if (rt) rt.logs.push({ ts: nowIso(), level, msg, data })
  const payload = data ? { msg, ...data } : { msg }
  if (level === 'error') console.error('[ytg]', payload)
  else if (level === 'warn') console.warn('[ytg]', payload)
  else console.log('[ytg]', payload)
}

type RetryImagesRequest = {
  job_id: string
  scene_ids?: number[]
  missing_only?: boolean
  // 내부 self-requeue 용 (프론트에서 보낼 필요 없음)
  depth?: number
}

type RetryImagesResponse = {
  job_id: string
  attempted: number
  succeeded: number
  failed: number
  skipped: number
  accepted?: boolean
  message?: string
}

async function runRetryInBackground(args: {
  jobId: string
  bucket: string
  topic: string
  style: any
  packager: any
  tasks: Array<{ scene_id: number; prompt: string }>
  depth: number
}) {
  const { jobId, bucket, topic, style, packager, tasks, depth } = args
  const supabase = getSupabaseServiceClient()

  pushRuntimeLog(packager, 'info', '이미지 재시도 백그라운드 작업 시작', { job_id: jobId, tasks: tasks.length })

  const startedAt = Date.now()
  const maxRuntimeMs = Math.max(5000, Math.min(Number(Deno.env.get('RETRY_IMAGES_MAX_RUNTIME_MS') ?? '50000') || 50000, 110000))
  const maxDepth = Math.max(0, Math.min(Number(Deno.env.get('RETRY_IMAGES_MAX_DEPTH') ?? '10') || 10, 30))

  let attempted = 0
  let succeeded = 0
  let failed = 0
  let skipped = 0

  let remainingSceneIds: number[] = []

  for (let idx = 0; idx < tasks.length; idx++) {
    if (Date.now() - startedAt > maxRuntimeMs) {
      remainingSceneIds = tasks.slice(idx).map((x) => Number(x.scene_id)).filter((n) => Number.isFinite(n))
      pushRuntimeLog(packager, 'warn', '실행 시간 예산 초과로 다음 배치로 넘깁니다.', {
        job_id: jobId,
        depth,
        maxRuntimeMs,
        remaining: remainingSceneIds.length,
      })
      break
    }

    const t = tasks[idx]
    const sceneId = Number(t.scene_id)
    const prompt = String(t.prompt ?? '').trim()
    if (!Number.isFinite(sceneId) || !prompt) {
      skipped++
      continue
    }
    attempted++
    try {
      pushRuntimeLog(packager, 'info', '이미지 재생성 시작', { scene_id: sceneId })
      const png = await openaiImagePng(prompt)
      const path = `jobs/${jobId}/scene-${String(sceneId).padStart(2, '0')}-${safeFilename(topic).slice(0, 48)}.png`

      const up = await supabase.storage.from(bucket).upload(path, new Blob([toArrayBuffer(png)], { type: 'image/png' }), {
        contentType: 'image/png',
        upsert: true,
      })
      if (up.error) throw new Error(up.error.message)

      const publicUrl = supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl

      const upd = await supabase
        .from('ytg_scenes')
        .update({ image_path: path, image_url: publicUrl, image_prompt: prompt })
        .eq('job_id', jobId)
        .eq('scene_id', sceneId)
      if (upd.error) throw new Error(upd.error.message)

      const insAsset = await supabase.from('ytg_assets').insert({
        job_id: jobId,
        type: 'image',
        path,
        url: publicUrl,
        meta: { scene_id: sceneId, prompt, retried_at: nowIso() },
      })
      if (insAsset.error) {
        pushRuntimeLog(packager, 'warn', 'ytg_assets 기록 실패(무시)', { scene_id: sceneId, error: insAsset.error.message })
      }

      succeeded++
      pushRuntimeLog(packager, 'info', '이미지 재생성 완료', { scene_id: sceneId })
    } catch (e: any) {
      failed++
      pushRuntimeLog(packager, 'error', '이미지 재생성 실패', { scene_id: sceneId, error: e?.message ?? String(e) })
    }

    // best-effort persist logs as we go
    try {
      await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    } catch {
      // ignore
    }
  }

  pushRuntimeLog(packager, 'info', '이미지 재시도 백그라운드 작업 종료', { attempted, succeeded, failed, skipped })
  await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

  // 남은 작업이 있으면 self-requeue (Edge Function 실행 제한/중단 대비)
  if (remainingSceneIds.length > 0 && depth < maxDepth) {
    const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const authKey = pickJwtKey([serviceRoleKey, anonKey])
    const endpoint = `${supabaseUrl}/functions/v1/trendstory-retry-images`
    const body: RetryImagesRequest = {
      job_id: jobId,
      scene_ids: remainingSceneIds,
      missing_only: true,
      depth: depth + 1,
    }

    const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil
    pushRuntimeLog(packager, 'info', '이미지 재시도 다음 배치 요청(인증 정보 점검)', {
      depth,
      next_depth: depth + 1,
      auth_segments: authKey.split('.').length,
      auth_len: authKey.length,
    })

    const auth = buildEdgeFunctionAuthHeaders(authKey)
    if (!auth.ok) {
      pushRuntimeLog(packager, 'error', 'self-requeue 인증키가 비어있습니다. Supabase Secrets를 확인하세요.', {
        hint: 'SUPABASE_SERVICE_ROLE_KEY 또는 SUPABASE_ANON_KEY가 필요합니다.',
      })
      return
    }
    if (!auth.jwtLike) {
      pushRuntimeLog(packager, 'warn', 'self-requeue 인증키가 JWT가 아닙니다. 이 경우 함수 verify_jwt=false가 필요합니다.', {
        hint: 'Supabase Dashboard → Edge Functions → trendstory-retry-images → JWT Verification(verify_jwt) 끄기',
      })
    }

    const kick = fetch(endpoint, {
      method: 'POST',
      headers: auth.headers,
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        const t = await r.text().catch(() => '')
        pushRuntimeLog(packager, 'info', '이미지 재시도 다음 배치 요청 완료', { status: r.status, body: t.slice(0, 200) })
      })
      .catch((e: any) => {
        pushRuntimeLog(packager, 'error', '이미지 재시도 다음 배치 요청 실패', { error: e?.message ?? String(e) })
      })

    if (typeof waitUntil === 'function') waitUntil(kick)
    else await kick
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let payload: RetryImagesRequest
  try {
    payload = (await req.json()) as RetryImagesRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const jobId = String(payload?.job_id ?? '').trim()
  if (!jobId) return json({ error: 'job_id is required' }, 400)

  const depth = Number((payload as any)?.depth ?? 0) || 0

  const supabase = getSupabaseServiceClient()
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  const jobRes = await supabase.from('ytg_jobs').select('id, input, packager, trace_id').eq('id', jobId).single()
  if (jobRes.error) return json({ error: jobRes.error.message }, 500)

  const scenesRes = await supabase
    .from('ytg_scenes')
    .select('id, job_id, scene_id, image_prompt, image_url, visual_brief, mood, on_screen_text')
    .eq('job_id', jobId)
    .order('scene_id', { ascending: true })
  if (scenesRes.error) return json({ error: scenesRes.error.message }, 500)

  const scenes = scenesRes.data ?? []
  const wantIdsRaw = Array.isArray(payload.scene_ids) ? payload.scene_ids : null
  const wantSet = wantIdsRaw ? new Set(wantIdsRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n))) : null
  const missingOnly = payload.missing_only !== false

  const packager = jobRes.data.packager ?? null
  const style = (packager as any)?.style_guide ?? {}
  const topic = String((jobRes.data.input as any)?.topic_domain ?? 'topic').trim()

  const renderReqs = Array.isArray((packager as any)?.image_render_requests) ? (packager as any).image_render_requests : []
  const promptByScene = new Map<number, string>()
  for (const r of renderReqs) {
    const sid = Number(r?.scene_id)
    const p = String(r?.prompt ?? '').trim()
    if (Number.isFinite(sid) && p) promptByScene.set(sid, p)
  }

  pushRuntimeLog(packager, 'info', '누락 이미지 재시도 시작', {
    job_id: jobId,
    missing_only: missingOnly,
    requested_scene_ids: wantIdsRaw ?? null,
  })

  const tasks: Array<{ scene_id: number; prompt: string }> = []
  let skipped = 0

  for (const s of scenes) {
    const sceneId = Number(s.scene_id)
    const hasImage = Boolean(s.image_url)
    if (wantSet && !wantSet.has(sceneId)) {
      skipped++
      continue
    }
    if (missingOnly && hasImage) {
      skipped++
      continue
    }

    const prompt =
      String(s.image_prompt ?? '').trim() ||
      String(promptByScene.get(sceneId) ?? '').trim() ||
      [
        String(s.visual_brief ?? '').trim() || String(s.on_screen_text ?? '').trim() || `educational illustration about ${topic}`,
        String(s.mood ?? '').trim(),
        String(style.visual_style ?? '').trim(),
        String(style.tone ?? '').trim(),
        'no text, no logo, no watermark, clean composition, high quality, 16:9',
      ]
        .filter(Boolean)
        .join(', ')
        .trim()

    if (!prompt) {
      skipped++
      pushRuntimeLog(packager, 'warn', '이미지 프롬프트가 비어 스킵', { scene_id: sceneId })
      continue
    }

    tasks.push({ scene_id: sceneId, prompt })
  }

  // 즉시 응답 후 백그라운드에서 실행 (브라우저 CORS/504 방지)
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil
  if (typeof waitUntil === 'function') {
    waitUntil(runRetryInBackground({ jobId, bucket, topic, style, packager, tasks, depth }))
  } else {
    // fallback: inline (개발 환경)
    runRetryInBackground({ jobId, bucket, topic, style, packager, tasks, depth })
  }

  // best-effort: store initial logs + queue info
  if (packager) await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

  const out: RetryImagesResponse = {
    job_id: jobId,
    attempted: tasks.length,
    succeeded: 0,
    failed: 0,
    skipped,
    accepted: true,
    message: '재시도 작업을 백그라운드로 시작했습니다. 잠시 후 새로고침하면 이미지가 채워집니다.',
  }
  return json(out, 202)
})


