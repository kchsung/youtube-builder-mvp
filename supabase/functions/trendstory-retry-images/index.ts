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
  const envSize = Deno.env.get('OPENAI_IMAGE_SIZE')?.trim()
  const sizes = Array.from(new Set([envSize, '1792x1024', '1024x1024'].filter(Boolean))) as string[]
  const timeoutMs = Number(Deno.env.get('OPENAI_IMAGE_TIMEOUT_MS') ?? '180000') || 180000
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
            body: JSON.stringify({ model: 'gpt-image-1', prompt, size }),
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
}) {
  const { jobId, bucket, topic, style, packager, tasks } = args
  const supabase = getSupabaseServiceClient()

  pushRuntimeLog(packager, 'info', '이미지 재시도 백그라운드 작업 시작', { job_id: jobId, tasks: tasks.length })

  let attempted = 0
  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (const t of tasks) {
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
    waitUntil(runRetryInBackground({ jobId, bucket, topic, style, packager, tasks }))
  } else {
    // fallback: inline (개발 환경)
    runRetryInBackground({ jobId, bucket, topic, style, packager, tasks })
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


