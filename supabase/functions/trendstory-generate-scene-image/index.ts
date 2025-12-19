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
  return createClient(url, serviceRoleKey, {
    db: { schema: 'public' },
  })
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

type GenerateSceneImageRequest = {
  job_id: string
  scene_id: number
  force?: boolean
}

type GenerateSceneImageResponse = {
  job_id: string
  scene_id: number
  accepted: boolean
  status: 'QUEUED' | 'ALREADY_EXISTS' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  image_url?: string | null
  message?: string
}

async function claimSceneImageGeneration(args: { supabase: any; jobId: string; sceneId: number; requestId: string; staleBeforeIso: string }) {
  const { supabase, jobId, sceneId, requestId, staleBeforeIso } = args

  // Claim if:
  // - never claimed (status is null)
  // - not generating
  // - generating but stale
  // 먼저 현재 상태를 확인
  const check = await supabase
    .from('ytg_scenes')
    .select('id, image_gen_status, image_gen_started_at')
    .eq('job_id', jobId)
    .eq('scene_id', sceneId)
    .single()

  if (check.error) throw new Error(check.error.message)
  if (!check.data) return false

  const currentStatus = check.data.image_gen_status
  const startedAt = check.data.image_gen_started_at

  // Claim 가능한지 확인
  const canClaim =
    currentStatus === null ||
    currentStatus !== 'GENERATING' ||
    (startedAt && new Date(startedAt) < new Date(staleBeforeIso))

  if (!canClaim) return false

  // Claim 실행
  const upd = await supabase
    .from('ytg_scenes')
    .update({
      image_gen_status: 'GENERATING',
      image_gen_request_id: requestId,
      image_gen_started_at: nowIso(),
      image_gen_error: null,
    })
    .eq('job_id', jobId)
    .eq('scene_id', sceneId)
    .eq('id', check.data.id)
    .select('id')

  if (upd.error) throw new Error(upd.error.message)
  return Array.isArray(upd.data) && upd.data.length > 0
}

async function runGenerate(jobId: string, sceneId: number, force: boolean) {
  const supabase = getSupabaseServiceClient()
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  const jobRes = await supabase.from('ytg_jobs').select('id, input, packager').eq('id', jobId).single()
  if (jobRes.error) throw new Error(jobRes.error.message)

  const sceneRes = await supabase
    .from('ytg_scenes')
    .select('id, scene_id, image_url, image_prompt, visual_brief, mood, on_screen_text, image_gen_status, image_gen_started_at')
    .eq('job_id', jobId)
    .eq('scene_id', sceneId)
    .single()
  if (sceneRes.error) throw new Error(sceneRes.error.message)

  const existingUrl = sceneRes.data?.image_url ?? null
  if (!force && existingUrl) {
    const out: GenerateSceneImageResponse = {
      job_id: jobId,
      scene_id: sceneId,
      accepted: true,
      status: 'ALREADY_EXISTS',
      image_url: existingUrl,
      message: '이미 생성된 이미지가 있습니다.',
    }
    return out
  }

  const requestId = crypto.randomUUID()
  const staleMs = Math.max(60_000, Math.min(Number(Deno.env.get('SCENE_IMAGE_LOCK_STALE_MS') ?? '300000') || 300000, 3_600_000))
  const staleBeforeIso = new Date(Date.now() - staleMs).toISOString()

  const claimed = await claimSceneImageGeneration({ supabase, jobId, sceneId, requestId, staleBeforeIso })
  if (!claimed) {
    const out: GenerateSceneImageResponse = {
      job_id: jobId,
      scene_id: sceneId,
      accepted: false,
      status: 'IN_PROGRESS',
      message: '이미지 생성이 진행 중입니다. 잠시 후 다시 시도하세요.',
    }
    return out
  }

  try {
    const packager = jobRes.data.packager ?? null
    const style = (packager as any)?.style_guide ?? {}
    const topic = String((jobRes.data.input as any)?.topic_domain ?? 'topic').trim()

    const prompt =
      String(sceneRes.data?.image_prompt ?? '').trim() ||
      [
        String(sceneRes.data?.visual_brief ?? '').trim() ||
          String(sceneRes.data?.on_screen_text ?? '').trim() ||
          `educational illustration about ${topic}`,
        String(sceneRes.data?.mood ?? '').trim(),
        String(style.visual_style ?? '').trim(),
        String(style.tone ?? '').trim(),
        'no text, no logo, no watermark, clean composition, high quality, 16:9',
      ]
        .filter(Boolean)
        .join(', ')
        .trim()

    if (!prompt) throw new Error('이미지 프롬프트가 비어있습니다.')

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
      .update({
        image_path: path,
        image_url: publicUrl,
        image_prompt: prompt,
        image_gen_status: 'SUCCEEDED',
        image_gen_error: null,
      })
      .eq('job_id', jobId)
      .eq('scene_id', sceneId)
      .eq('image_gen_request_id', requestId)
    if (upd.error) throw new Error(upd.error.message)

    const insAsset = await supabase.from('ytg_assets').insert({
      job_id: jobId,
      type: 'image',
      path,
      url: publicUrl,
      meta: { kind: 'scene', scene_id: sceneId, prompt, generated_at: nowIso(), request_id: requestId, force },
    })
    if (insAsset.error) {
      // best-effort
      console.warn('[ytg] ytg_assets insert failed (ignored)', insAsset.error.message)
    }

    const out: GenerateSceneImageResponse = {
      job_id: jobId,
      scene_id: sceneId,
      accepted: true,
      status: 'SUCCEEDED',
      image_url: publicUrl,
      message: '이미지 생성 완료',
    }
    return out
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    await supabase
      .from('ytg_scenes')
      .update({ image_gen_status: 'FAILED', image_gen_error: msg })
      .eq('job_id', jobId)
      .eq('scene_id', sceneId)
      .eq('image_gen_request_id', requestId)

    const out: GenerateSceneImageResponse = {
      job_id: jobId,
      scene_id: sceneId,
      accepted: true,
      status: 'FAILED',
      message: msg,
    }
    return out
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let payload: GenerateSceneImageRequest
  try {
    payload = (await req.json()) as GenerateSceneImageRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const jobId = String(payload?.job_id ?? '').trim()
  const sceneId = Number(payload?.scene_id)
  const force = Boolean(payload?.force)

  if (!jobId) return json({ error: 'job_id is required' }, 400)
  if (!Number.isFinite(sceneId) || sceneId <= 0) return json({ error: 'scene_id is required' }, 400)

  try {
    const out = await runGenerate(jobId, sceneId, force)
    // IN_PROGRESS는 UI에서 "이미 생성 중"으로 처리하면 되므로 202로 돌려줍니다.
    if (out.status === 'IN_PROGRESS') return json(out, 202)
    return json(out, 200)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    const hint =
      msg.includes('Missing required env:') || msg.includes('Missing secret:')
        ? 'Supabase Dashboard → Edge Functions → Secrets 에서 OPENAI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 등을 설정했는지 확인하세요.'
        : msg.includes('column') && msg.includes('image_gen_')
          ? 'DB 마이그레이션이 적용되지 않았습니다. SQL Editor에서 supabase/migrations/2025-12-19_add_scene_image_generation_lock.sql 을 실행하세요.'
          : msg.includes('relation') && msg.includes('ytg_')
            ? 'DB 테이블/마이그레이션이 적용되었는지 확인하세요.'
            : undefined

    console.error('[ytg] trendstory-generate-scene-image error', { jobId, sceneId, msg })
    return json({ error: msg, hint }, 500)
  }
})


