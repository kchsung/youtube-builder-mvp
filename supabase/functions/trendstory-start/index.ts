// @ts-nocheck
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

function requireEnv(name: string) {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`Missing required env: ${name}`)
  return v
}

function getTextModelCandidates(preferred?: string) {
  const envModel = Deno.env.get('OPENAI_TEXT_MODEL')?.trim()
  const candidates = [
    // user requested default (always try first)
    'gpt-5.2',
    preferred?.trim(),
    envModel,
    // safe defaults that many projects have access to
    'gpt-4o-mini',
    'gpt-4o',
  ].filter((m): m is string => Boolean(m))
  // de-dup preserving order
  return Array.from(new Set(candidates))
}

function isModelAccessError(errText: string) {
  try {
    const j = JSON.parse(errText)
    const code = j?.error?.code
    const msg = j?.error?.message ?? ''
    if (code === 'model_not_found') return true
    if (typeof msg === 'string' && msg.includes('does not have access to model')) return true
  } catch {
    // ignore
  }
  return false
}

function pickJwtKey(keys: Array<string | null | undefined>) {
  for (const k of keys) {
    const t = (k ?? '').trim()
    if (!t) continue
    if (t.split('.').length >= 3) return t
  }
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
  const headers: Record<string, string> = { apikey: t, 'content-type': 'application/json' }
  if (jwtLike) headers.Authorization = `Bearer ${t}`
  return { ok: true, headers, jwtLike }
}

// ---- Supabase clients (단일 파일 배포를 위해 index.ts에 포함) ----
function getSupabaseAnonClient(req: Request) {
  const url = requireEnv('SUPABASE_URL')
  const anonKey = requireEnv('SUPABASE_ANON_KEY')

  // 클라이언트에서 온 Authorization 헤더(anon JWT)를 그대로 전달
  const authHeader = req.headers.get('authorization') ?? ''

  return createClient(url, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })
}

function getSupabaseServiceClient() {
  const url = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, serviceRoleKey)
}

// ---- 최소 타입들 (단일 파일 배포를 위해 index.ts에 포함) ----
type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

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
}

type DbAssetRow = {
  id: string
  job_id: string
  type: 'image' | 'audio' | 'json'
  path: string | null
  url: string | null
  meta: unknown | null
}

type TrendStoryStartRequest = {
  topic_domain: string
  language: string
  audience: string
  input_as_text?: string
  job_id?: string // 기존 job 재사용 시 (재시작)
}

type TrendStoryStartResponse = {
  job_id: string
  trace_id?: string
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

function badRequest(message: string) {
  return json({ error: message }, 400)
}

function stripJsonFences(s: string) {
  const t = s.trim()
  if (t.startsWith('```')) {
    return t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim()
  }
  return t
}

function extractJsonObjectFromText(text: string): unknown {
  const s = text.trim()
  // 1) plain JSON
  try {
    const parsed = JSON.parse(stripJsonFences(s))
    // common pattern: { "DATA": { ...actual payload... } }
    if (parsed && typeof parsed === 'object') {
      const anyParsed: any = parsed
      if (anyParsed.DATA && typeof anyParsed.DATA === 'object') return anyParsed.DATA
      if (anyParsed.data && typeof anyParsed.data === 'object') return anyParsed.data
    }
    return parsed
  } catch {
    // ignore
  }

  // 2) try after "DATA"
  const idx = s.toUpperCase().lastIndexOf('DATA')
  const from = idx >= 0 ? s.slice(idx) : s
  const start = from.indexOf('{')
  if (start < 0) throw new Error('No JSON object found in output')

  const src = from.slice(start)
  // balanced brace scan
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (depth === 0) {
      const candidate = src.slice(0, i + 1)
      const parsed = JSON.parse(candidate)
      // common wrapper: { "DATA": {...} } or { "data": {...} }
      if (parsed && typeof parsed === 'object') {
        const anyParsed: any = parsed
        if (anyParsed.DATA && typeof anyParsed.DATA === 'object') return anyParsed.DATA
        if (anyParsed.data && typeof anyParsed.data === 'object') return anyParsed.data
      }
      return parsed
    }
  }
  throw new Error('Failed to parse JSON object from output')
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

async function openaiJson<T>(payload: any): Promise<T> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const models = getTextModelCandidates(payload?.model)
  let lastErr: unknown = null

  for (const model of models) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...payload, model }),
    })
    const text = await res.text()
    if (!res.ok) {
      lastErr = new Error(`OpenAI error (${res.status}): ${text}`)
      // try next model if access/model error
      if (res.status === 403 && isModelAccessError(text)) continue
      if (res.status === 404 && isModelAccessError(text)) continue
      throw lastErr
    }

    const json = JSON.parse(text)
    const content: string = json?.choices?.[0]?.message?.content ?? ''
    if (!content) throw new Error('OpenAI returned empty content')
    return extractJsonObjectFromText(content) as T
  }

  throw lastErr ?? new Error('OpenAI error: no available text model')
}

async function openaiResponsesText(body: any): Promise<string> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const models = getTextModelCandidates(body?.model)
  let lastErr: unknown = null

  for (const model of models) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body, model }),
    })
    const text = await res.text()
    if (!res.ok) {
      lastErr = new Error(`OpenAI responses error (${res.status}): ${text}`)
      if (res.status === 403 && isModelAccessError(text)) continue
      if (res.status === 404 && isModelAccessError(text)) continue
      throw lastErr
    }

    const json = JSON.parse(text)

    if (typeof json?.output_text === 'string' && json.output_text.trim()) return json.output_text

    const out = json?.output
    if (Array.isArray(out)) {
      for (const item of out) {
        if (item?.type === 'message') {
          const content = item?.content
          if (Array.isArray(content)) {
            const parts = content
              .map((c: any) => (c?.type === 'output_text' ? c?.text : c?.text))
              .filter((v: any) => typeof v === 'string')
            const joined = parts.join('')
            if (joined.trim()) return joined
          }
        }
      }
    }
  }

  throw lastErr ?? new Error('OpenAI responses returned empty output_text')
}

async function openaiResponsesJson<T>(body: any): Promise<T> {
  const text = await openaiResponsesText(body)
  return extractJsonObjectFromText(text) as T
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
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: imageModel,
              prompt,
              size,
            }),
          },
          timeoutMs,
        )
        text = await res.text()
      } catch (e: any) {
        const msg = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e)
        lastErr = new Error(`OpenAI image request failed (${size}, attempt ${attempt}): ${msg}`)
        // timeout/network -> retry with backoff
        await sleepMs(600 * attempt)
        continue
      }

      if (!res.ok) {
        lastErr = new Error(`OpenAI image error (${res.status}, size=${size}, attempt=${attempt}): ${text}`)
        // size/param 이슈면 다음 size로 재시도
        if (res.status === 400) break
        // rate limit / transient -> retry
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
      // unexpected shape -> retry once then give up
      await sleepMs(400 * attempt)
    }
  }

  throw lastErr ?? new Error('OpenAI image error: no valid size worked')
}

async function openaiTtsMp3(input: string): Promise<Uint8Array> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const ttsModel = Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts'
  const ttsVoice = Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy'
  // TTS timeout: 기본 60초 (환경변수로 override 가능, 최대 180초)
  const timeoutMs = Math.max(10000, Math.min(Number(Deno.env.get('OPENAI_TTS_TIMEOUT_MS') ?? '60000') || 60000, 180000))
  const maxAttempts = Math.max(1, Math.min(Number(Deno.env.get('OPENAI_TTS_MAX_ATTEMPTS') ?? '2') || 2, 5))

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(
        'https://api.openai.com/v1/audio/speech',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: ttsModel,
            voice: ttsVoice,
            format: 'mp3',
            input,
          }),
        },
        timeoutMs,
      )

      if (!res.ok) {
        const text = await res.text()
        lastErr = new Error(`OpenAI TTS error (${res.status}, attempt ${attempt}): ${text}`)
        // 400 (bad request)는 재시도 불가
        if (res.status === 400) throw lastErr
        // 429 (rate limit) / 500+ (server error)는 재시도
        if (res.status === 429 || res.status >= 500) {
          await sleepMs(800 * attempt)
          continue
        }
        throw lastErr
      }

      const ab = await res.arrayBuffer()
      return new Uint8Array(ab)
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : e?.message ?? String(e)
      lastErr = new Error(`OpenAI TTS request failed (attempt ${attempt}): ${msg}`)
      // timeout/network -> 재시도
      if (attempt < maxAttempts) {
        await sleepMs(600 * attempt)
        continue
      }
      throw lastErr
    }
  }

  throw lastErr ?? new Error('OpenAI TTS error: max attempts exceeded')
}

type AutoConfigOutput = {
  language: string
  audience: string
  tone: string
  duration_min: number
  platform_target: string
  visual_style: string
  main_character_hint: string
  safety_level: string
  scene_count: number
  scene_seeds: Array<{ scene_title: string; seed: string }>
}

type PackagerOutput = {
  trend_research: unknown
  story: unknown
  scenes: Array<{
    scene_id: number
    narration: string
    on_screen_text: string
    visual_brief: string
    mood: string
    duration_sec: number
  }>
  style_guide: {
    tone?: string
    platform_target?: string
    visual_style?: string
    main_character_hint?: string
    safety_level?: string
  }
  image_prompts?: Array<{ scene_id: number; prompt: string }>
  image_render_requests: Array<{ scene_id: number; prompt: string; size: string; n: number }>
  tts: { full_script: string }
  video_package?: unknown
  youtube_meta: {
    titles: string[]
    hook_lines: string[]
    thumbnail_texts: string[]
    thumbnail_image_prompts?: string[]
    hashtags: string[]
  }
  // runtime-only metadata (we inject this server-side)
  _runtime?: {
    started_at?: string
    logs?: Array<{ ts: string; level: 'info' | 'warn' | 'error'; msg: string; data?: unknown }>
    autoconfig_status?: 'waiting' | 'running' | 'done'
    packager_status?: 'waiting' | 'running' | 'done'
    image_render_requests_generated?: boolean
    image_render_requests_count?: number
    images_success?: number
    images_failed?: number
    images_skipped?: number
    images_errors?: Array<{ scene_id?: number; error: string }>
  }
}

function safeFilename(s: string) {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function nowIso() {
  return new Date().toISOString()
}

function platformTargetToRequestedSize(platformTarget?: string | null) {
  if (platformTarget === 'youtube_16_9') return '1920x1080'
  if (platformTarget === 'shorts_9_16') return '1080x1920'
  return '1024x1024'
}

function ensureRuntime(packager: PackagerOutput) {
  if (!packager._runtime) packager._runtime = {}
  if (!packager._runtime.logs) packager._runtime.logs = []
  if (!packager._runtime.started_at) packager._runtime.started_at = nowIso()
  return packager._runtime
}

function pushRuntimeLog(packager: PackagerOutput, level: 'info' | 'warn' | 'error', msg: string, data?: unknown) {
  const rt = ensureRuntime(packager)
  rt.logs!.push({ ts: nowIso(), level, msg, data })
  // also log to function logs (Supabase Dashboard)
  const payload = data ? { msg, ...data } : { msg }
  if (level === 'error') console.error('[ytg]', payload)
  else if (level === 'warn') console.warn('[ytg]', payload)
  else console.log('[ytg]', payload)
}

function normalizeImageRenderRequests(
  packager: PackagerOutput,
  sceneIds: number[],
  platformTarget?: string | null,
): { requests: Array<{ scene_id: number; prompt: string; size: string; n: number }>; generated: boolean } {
  const existing = Array.isArray(packager.image_render_requests) ? packager.image_render_requests : []
  const validSet = new Set(sceneIds)
  const cleaned = existing
    .map((r) => ({
      scene_id: Number((r as any)?.scene_id),
      prompt: String((r as any)?.prompt ?? '').trim(),
      size: String((r as any)?.size ?? '').trim(),
      n: Number((r as any)?.n ?? 1) || 1,
    }))
    .filter((r) => Number.isFinite(r.scene_id) && validSet.has(r.scene_id) && r.prompt.length > 0)
    .map((r) => ({ ...r, size: r.size || platformTargetToRequestedSize(platformTarget), n: 1 }))

  if (cleaned.length > 0) return { requests: cleaned, generated: false }

  // fallback: build from image_prompts or from scenes
  const byId = new Map<number, string>()
  if (Array.isArray(packager.image_prompts)) {
    for (const p of packager.image_prompts) {
      const sid = Number((p as any)?.scene_id)
      const prompt = String((p as any)?.prompt ?? '').trim()
      if (Number.isFinite(sid) && validSet.has(sid) && prompt) byId.set(sid, prompt)
    }
  }

  // if still empty, try from scenes + style guide
  if (byId.size === 0) {
    const style = packager.style_guide ?? {}
    const visual = (style.visual_style ?? '').toString().trim()
    const tone = (style.tone ?? '').toString().trim()
    for (const s of packager.scenes ?? []) {
      const sid = Number((s as any)?.scene_id)
      if (!Number.isFinite(sid) || !validSet.has(sid)) continue
      const brief = String((s as any)?.visual_brief ?? '').trim()
      const mood = String((s as any)?.mood ?? '').trim()
      const onScreen = String((s as any)?.on_screen_text ?? '').trim()
      const prompt = [
        brief || onScreen || 'educational illustration',
        mood,
        visual,
        tone,
        'no text, no logo, no watermark, clean composition, high quality, 16:9',
      ]
        .filter(Boolean)
        .join(', ')
      if (prompt.trim()) byId.set(sid, prompt.trim())
    }
  }

  const size = platformTargetToRequestedSize(platformTarget)
  const reqs = sceneIds
    .filter((sid) => byId.has(sid))
    .map((sid) => ({ scene_id: sid, prompt: byId.get(sid)!, size, n: 1 }))

  return { requests: reqs, generated: true }
}

async function runPipeline(jobId: string, traceId: string, payload: TrendStoryStartRequest) {
  const supabase = getSupabaseServiceClient()
  const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  try {
    await supabase.from('ytg_jobs').update({ status: 'RUNNING' satisfies JobStatus, error: null }).eq('id', jobId)

    // packager 객체 초기화 (상태 추적용)
    const packager: PackagerOutput = { _runtime: {} } as PackagerOutput
    ensureRuntime(packager)
    packager._runtime!.autoconfig_status = 'running'
    packager._runtime!.packager_status = 'waiting'
    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

    // ---- 0) AutoConfig Agent ----
    const extraPrompt = payload.input_as_text?.trim() ? payload.input_as_text.trim() : null

    const autoconfigInstructions = `너는 AutoConfig Agent다.
입력은 JSON 1개이며 다음 키를 포함한다:
- topic_domain (string, required)
- language (string, required)
- audience (string, required)

목표:
- TrendStory Packager Agent가 바로 사용할 수 있도록, 아래 config JSON을 생성한다.
- 사용자 입력(topic_domain/language/audience)을 반드시 반영한다.
- scene_count는 6~12 사이에서 topic_domain에 맞게 선택한다.
- scene_seeds는 scene_count 개수만큼 만들고, topic_domain과 자연스럽게 연결된 사건/학습 포인트가 들어가야 한다.
- 위험/혐오/성적/폭력 과도 요소는 배제하고 아동·청소년 안전을 우선한다.

반드시 출력할 JSON 키:
language, audience, tone, duration_min, platform_target, visual_style,
main_character_hint, safety_level, scene_count, scene_seeds

기본값 규칙(입력이 비어있거나 누락된 경우에만 적용):
- language: "ko"
- audience: "중학생"
- tone: "모험"
- duration_min: scene_count에 맞춰 4~7분 범위로 추정
- platform_target: "youtube_16_9"
- visual_style: "따뜻한 고퀄리티 일러스트"
- main_character_hint: "친근한 한국 학생 1~2명"
- safety_level: "strict"

추가 규칙:
- 아래 “추가 지시사항”이 있으면, visual_style / tone / main_character_hint / scene_seeds에 자연스럽게 반영하되, topic_domain과 무관한 이야기로 바꾸지 말 것.
- language가 "en"이면 scene_seeds/scene_title/seed는 영어로 작성한다.

추가 지시사항:
${extraPrompt ?? '(없음)'}

출력 형식:
- 오직 JSON만 출력한다. (설명/마크다운/코드펜스 금지)
- scene_seeds는 배열이며, 각 원소는 {scene_title, seed}를 포함한다.`

    const autoconfigInput = JSON.stringify({
      topic_domain: payload.topic_domain,
      language: payload.language,
      audience: payload.audience,
    })

    console.log('[ytg] autoconfig 생성 시작', { jobId })
    const autoconfig = await openaiResponsesJson<AutoConfigOutput>({
      model: 'gpt-5.2',
      input: [
        { role: 'system', content: autoconfigInstructions },
        { role: 'user', content: autoconfigInput },
      ],
    })
    console.log('[ytg] autoconfig 생성 완료', { jobId, scene_count: autoconfig.scene_count })

    packager._runtime!.autoconfig_status = 'done'
    packager._runtime!.packager_status = 'running'
    const updAutoconfig = await supabase.from('ytg_jobs').update({ autoconfig, packager }).eq('id', jobId)
    if (updAutoconfig.error) {
      console.error('[ytg] autoconfig DB 업데이트 실패', { jobId, error: updAutoconfig.error.message })
      throw new Error(`autoconfig DB 업데이트 실패: ${updAutoconfig.error.message}`)
    }
    console.log('[ytg] autoconfig DB 업데이트 완료', { jobId })

    // ---- 1) TrendStory Packager Agent ----
    console.log('[ytg] packager 생성 시작', { jobId, scene_count: autoconfig.scene_count ?? 6 })
    const packagerInstructions = `너는 TrendStory Packager Agent다.

[필수 입력]
- topic_domain (string)
- language (string)
- audience (string)
- scene_count (number)
- scene_seeds (json 또는 텍스트)

[옵션 입력 - 없으면 기본값 사용]
- tone (기본: "모험")
- platform_target (기본: "youtube_16_9")
- visual_style (기본: "따뜻한 고퀄리티 일러스트")
- main_character_hint (기본: "친근한 한국 학생 1~2명")
- safety_level (기본: "strict")
- duration_min (없으면 scene_count 기준으로 자동 추정)

[해야 할 일]
1) topic_domain에 대해 최근 트렌드 토픽/키워드를 간단히 정리하고(selected_topic 1개 선택)
2) scene_seeds의 의도를 유지하며 전체 이야기(story)를 구성/보강
3) scene_count에 맞춰 scenes[1..scene_count]를 확정(각 씬: narration/on_screen_text/visual_brief/mood/duration_sec)
4) style_guide를 기본값 또는 옵션 입력으로 확정
5) scene_id별 image_prompts를 1개씩 생성
6) TTS용 full_script(전체 내레이션) 생성
7) YouTube 메타(titles/hook_lines/thumbnail_texts/thumbnail_image_prompts/hashtags) 생성
8) 간단한 video_package.timeline 생성(씬 순서대로 start/end)

추가 출력: image_render_requests 배열을 반드시 생성하라.
규칙: image_render_requests = image_prompts를 scene_id별로 변환하되 size는 style_guide.platform_target이 youtube_16_9면 "1920x1080", shorts_9_16면 "1080x1920", 그 외는 "1024x1024", n=1로 고정.

[출력]
- 오직 JSON만 출력한다. (설명/마크다운/코드펜스 금지)
- 최상위 JSON에 다음 키를 반드시 포함한다:
  trend_research, story, scenes, style_guide, image_prompts, image_render_requests, tts, video_package, youtube_meta
- "DATA" 같은 래퍼 키로 감싸지 말 것.`

    const packagerInputObj = {
      topic_domain: payload.topic_domain,
      // payload에서 이미 필수 검증을 했으므로, 사용자가 넣은 값을 우선합니다.
      // (autoconfig가 기본값 ko/중학생으로 튀어도 packager를 덮어쓰지 않도록)
      language: payload.language,
      audience: payload.audience,
      scene_count: autoconfig.scene_count ?? 6,
      scene_seeds: autoconfig.scene_seeds ?? [],
      tone: autoconfig.tone,
      duration_min: autoconfig.duration_min,
      platform_target: autoconfig.platform_target,
      visual_style: autoconfig.visual_style,
      main_character_hint: autoconfig.main_character_hint,
      safety_level: autoconfig.safety_level,
      input_as_text: payload.input_as_text ?? null,
    }

    let packagerResult: PackagerOutput
    try {
      // 1차 시도: Responses API + web_search_preview tool
      // (Deno Edge에서 @openai/agents를 직접 실행하기 어려워, API 레벨로 web search를 사용)
      console.log('[ytg] packager API 호출 시작 (web_search 포함)', { jobId })
      packagerResult = await openaiResponsesJson<PackagerOutput>({
        model: 'gpt-5.2',
        input: [
          { role: 'system', content: packagerInstructions },
          { role: 'user', content: JSON.stringify(packagerInputObj) },
        ],
        tools: [
          {
            type: 'web_search_preview',
            search_context_size: 'medium',
            user_location: { type: 'approximate', country: 'KR' },
          },
        ],
      })
      console.log('[ytg] packager API 호출 완료 (web_search 포함)', { jobId, has_scenes: Array.isArray((packagerResult as any)?.scenes) })
    } catch (err: any) {
      console.warn('[ytg] packager API 호출 실패 (web_search 포함), fallback 시도', { jobId, error: err?.message ?? String(err) })
      // fallback: web search 없이 생성 (모델은 gpt-5.2 유지)
      packagerResult = await openaiResponsesJson<PackagerOutput>({
        model: 'gpt-5.2',
        input: [
          { role: 'system', content: packagerInstructions },
          { role: 'user', content: JSON.stringify(packagerInputObj) },
        ],
      })
      console.log('[ytg] packager API 호출 완료 (fallback)', { jobId, has_scenes: Array.isArray((packagerResult as any)?.scenes) })
    }
    // packagerResult를 기존 packager 객체에 병합 (상태 유지)
    Object.assign(packager, packagerResult)
    if (!packager._runtime) packager._runtime = {}
    if (!packager._runtime.logs) packager._runtime.logs = []

    // ---- packager sanity check & repair ----
    // 가끔 모델이 scenes를 누락/비우는 경우가 있어, 파이프라인이 "멈춘 것처럼" 보입니다.
    // scenes는 이후 DB insert/TTS/이미지 생성의 핵심이므로, 최소 1회 리페어 재시도를 합니다.
    const targetCount = Math.max(1, Math.min(Number(autoconfig.scene_count ?? 6) || 6, 12))
    const normalizeScenes = (p: PackagerOutput) =>
      (Array.isArray((p as any)?.scenes) ? ((p as any).scenes as any[]) : [])
        .slice(0, targetCount)
        .map((s, i) => ({ ...s, scene_id: Number.isFinite((s as any)?.scene_id) ? (s as any).scene_id : i + 1 }))
        .sort((a: any, b: any) => Number(a.scene_id) - Number(b.scene_id))

    let scenes = normalizeScenes(packager)
    if (scenes.length === 0) {
      // 디버그 힌트: 모델이 {DATA:{...}} 형태로 감싸거나 키를 빠뜨릴 수 있음
      try {
        const keys = packager && typeof packager === 'object' ? Object.keys(packager as any).slice(0, 40) : []
        const anyP: any = packager as any
        pushRuntimeLog(packager, 'warn', 'packager 루트 키 점검', {
          keys,
          has_DATA: Boolean(anyP?.DATA),
          has_data: Boolean(anyP?.data),
          data_keys: anyP?.DATA && typeof anyP.DATA === 'object' ? Object.keys(anyP.DATA).slice(0, 40) : null,
        })
      } catch {
        // ignore
      }
      pushRuntimeLog(packager, 'warn', 'packager.scenes가 비어 있어 packager를 1회 재시도합니다.', { targetCount })
      // "수정/리페어" 전용으로 더 강하게 요구
      const repairInstructions = `${packagerInstructions}

중요(리페어 모드):
- 이전 출력이 불완전하여 scenes가 비어 있었습니다.
- 반드시 scenes 배열을 최소 ${targetCount}개 포함하고, 각 scene에는 scene_id/narration/on_screen_text/visual_brief/mood/duration_sec 키를 포함한다.
- 오직 JSON만 출력한다.`

      packager = await openaiResponsesJson<PackagerOutput>({
        model: 'gpt-5.2',
        input: [
          { role: 'system', content: repairInstructions },
          { role: 'user', content: JSON.stringify(packagerInputObj) },
        ],
      })
      scenes = normalizeScenes(packager)
      if (scenes.length === 0) {
        throw new Error('Packager output is invalid: scenes is empty (after repair attempt)')
      }
    }

    packager._runtime!.packager_status = 'done'
    pushRuntimeLog(packager, 'info', 'packager 생성 완료', {
      has_image_render_requests: Array.isArray(packager?.image_render_requests),
      image_render_requests_len: Array.isArray(packager?.image_render_requests) ? packager.image_render_requests.length : 0,
      has_image_prompts: Array.isArray(packager?.image_prompts),
      image_prompts_len: Array.isArray(packager?.image_prompts) ? packager.image_prompts.length : 0,
      scenes_len: Array.isArray((packager as any)?.scenes) ? ((packager as any).scenes as any[]).length : 0,
    })
    console.log('[ytg] packager 생성 완료, DB 업데이트 시작', { jobId, scenes_count: scenes.length })

    const updPackager = await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    if (updPackager.error) {
      console.error('[ytg] packager DB 업데이트 실패', { jobId, error: updPackager.error.message })
      throw new Error(`packager DB 업데이트 실패: ${updPackager.error.message}`)
    }
    console.log('[ytg] packager DB 업데이트 완료', { jobId })

    // scenes는 위에서 normalize+검증 완료된 값을 사용

    // 1) scenes insert (text first)
    const insScenes = await supabase.from('ytg_scenes').insert(
      scenes.map((s) => ({
        job_id: jobId,
        scene_id: s.scene_id,
        narration: s.narration ?? null,
        on_screen_text: s.on_screen_text ?? null,
        visual_brief: s.visual_brief ?? null,
        mood: s.mood ?? null,
        duration_sec: s.duration_sec ?? null,
        image_prompt: null,
        image_path: null,
        image_url: null,
      })),
    )
    if (insScenes.error) throw new Error(insScenes.error.message)

    async function insertAssetBestEffort(row: Omit<DbAssetRow, 'id'>) {
      const ins = await supabase.from('ytg_assets').insert(row)
      if (ins.error) {
        pushRuntimeLog(packager, 'warn', 'ytg_assets 기록 실패(무시)', { error: ins.error.message, row })
      }
    }

    // 2) TTS (per-scene + full track) - 오디오를 먼저 생성한다.
    const ttsModel = Deno.env.get('OPENAI_TTS_MODEL')?.trim() || 'gpt-4o-mini-tts'
    const ttsVoice = Deno.env.get('OPENAI_TTS_VOICE')?.trim() || 'alloy'

    const sceneAudioUrls: Array<{ scene_id: number; audio_url: string }> = []
    const ttsTargetScenes = scenes
      .map((s) => ({ scene_id: s.scene_id, narration: String(s.narration ?? '').trim() }))
      .filter((s) => s.narration.length > 0)

    const rtTts: any = ensureRuntime(packager)
    if (rtTts) {
      rtTts.tts_scenes_total = ttsTargetScenes.length
      rtTts.tts_scenes_done = 0
      rtTts.tts_scenes_failed = 0
    }

    for (const s of ttsTargetScenes) {
      try {
        pushRuntimeLog(packager, 'info', 'TTS(씬) 생성 시작', { scene_id: s.scene_id, chars: s.narration.length })
        const mp3 = await openaiTtsMp3(s.narration)
        const audioPath = `jobs/${jobId}/tts/scene-${String(s.scene_id).padStart(2, '0')}.mp3`
        const upA = await supabase.storage.from(bucket).upload(audioPath, new Blob([toArrayBuffer(mp3)], { type: 'audio/mpeg' }), {
          contentType: 'audio/mpeg',
          upsert: true,
        })
        if (upA.error) throw new Error(upA.error.message)
        const url = supabase.storage.from(bucket).getPublicUrl(audioPath).data.publicUrl
        sceneAudioUrls.push({ scene_id: s.scene_id, audio_url: url })
        await insertAssetBestEffort({
          job_id: jobId,
          type: 'audio',
          path: audioPath,
          url,
          meta: { kind: 'scene', scene_id: s.scene_id, provider: 'openai', model: ttsModel, voice: ttsVoice },
        })
        if (rtTts) rtTts.tts_scenes_done = (rtTts.tts_scenes_done ?? 0) + 1
        pushRuntimeLog(packager, 'info', 'TTS(씬) 생성 완료', { scene_id: s.scene_id, audio_url: url })
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        if (rtTts) rtTts.tts_scenes_failed = (rtTts.tts_scenes_failed ?? 0) + 1
        pushRuntimeLog(packager, 'error', 'TTS(씬) 생성 실패', { scene_id: s.scene_id, error: msg })
        // keep going
      }
      // progress is useful; persist packager runtime occasionally
      await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    }

    // NOTE: full 트랙(전체 TTS)은 생성하지 않습니다(자원 낭비 방지). 씬별만 생성합니다.
    const audioUrl: string | null = null

    // 3) 이미지 생성은 "사용자 클릭 시 씬 단위로" 수행합니다.
    //    (일괄 생성/자동 트리거 제거)
    const norm = normalizeImageRenderRequests(packager, scenes.map((s) => s.scene_id), (packager.style_guide as any)?.platform_target ?? null)
    if (norm.generated) {
      packager.image_render_requests = norm.requests
      ensureRuntime(packager).image_render_requests_generated = true
      pushRuntimeLog(packager, 'warn', 'image_render_requests가 비어 있어 서버에서 자동 생성했습니다.', {
        generated_count: norm.requests.length,
      })
      await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)
    }
    ensureRuntime(packager).image_render_requests_count = norm.requests.length
    pushRuntimeLog(packager, 'info', '이미지 생성은 사용자 요청(씬 단위)로 진행됩니다.', {
      available: norm.requests.length,
      hint: '각 씬 이미지 영역의 "생성" 버튼을 눌러 1장씩 생성하세요.',
    })
    // packager의 _runtime 업데이트를 DB에 반영
    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

    // 4) assets insert (json marker only)
    const insAssets = await supabase.from('ytg_assets').insert({
      job_id: jobId,
      type: 'json',
      path: null,
      url: null,
      meta: { note: 'final_package is stored in jobs.final_package', trace_id: traceId },
    })
    if (insAssets.error) throw new Error(insAssets.error.message)

    // 5) final_package + job succeed
    const final_package = {
      version: 1,
      input: payload,
      autoconfig,
      packager_output: packager,
      youtube_meta: packager?.youtube_meta ?? null,
      video_package: packager?.video_package ?? null,
      scenes: scenes.map((s) => ({
        scene_id: s.scene_id,
        on_screen_text: s.on_screen_text,
        narration: s.narration,
        duration_sec: s.duration_sec,
        image: {
          // note: actual URL/prompt are stored on ytg_scenes rows; status endpoint returns them
          prompt: null,
        },
      })),
      audio: {
        audio_url: audioUrl,
        scene_audios: sceneAudioUrls,
        tts: { provider: 'openai', model: ttsModel, voice: ttsVoice },
      },
      meta: { storage_bucket: bucket, supabase_url: supabaseUrl, trace_id: traceId },
    }

    const updJob = await supabase
      .from('ytg_jobs')
      .update({ status: 'SUCCEEDED' satisfies JobStatus, final_package, packager, error: null })
      .eq('id', jobId)
    if (updJob.error) throw new Error(updJob.error.message)
  } catch (err: any) {
    const msg = err?.message ?? 'unknown error'
    await supabase.from('ytg_jobs').update({ status: 'FAILED' satisfies JobStatus, error: msg }).eq('id', jobId)
  }
}

Deno.serve(async (req) => {
  const opt = handleOptions(req)
  if (opt) return opt

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let payload: TrendStoryStartRequest
  try {
    payload = (await req.json()) as TrendStoryStartRequest
  } catch {
    return badRequest('Invalid JSON body')
  }

  if (!payload?.topic_domain?.trim()) return badRequest('topic_domain is required')
  if (!payload?.language?.trim()) return badRequest('language is required')
  if (!payload?.audience?.trim()) return badRequest('audience is required')

  // NOTE: 이 엔드포인트는 job_id를 즉시 반환하고,
  // EdgeRuntime.waitUntil로 백그라운드 생성 파이프라인을 수행합니다.
  // 따라서 프론트는 trendstory-status 폴링으로 결과를 받게 됩니다.
  const service = getSupabaseServiceClient()

  let jobId: string
  let traceId: string

  // 기존 job 재사용 (재시작)
  if (payload.job_id?.trim()) {
    const existingJobId = payload.job_id.trim()
    // 기존 job 확인
    const existingJob = await service.from('ytg_jobs').select('id, trace_id').eq('id', existingJobId).single()
    if (existingJob.error) {
      return json({ error: `기존 job을 찾을 수 없습니다: ${existingJob.error.message}` }, 404)
    }

    // 기존 job을 QUEUED로 리셋하고 입력값 업데이트
    const resetJob = await service
      .from('ytg_jobs')
      .update({
        status: 'QUEUED' satisfies JobStatus,
        input: payload,
        autoconfig: null,
        packager: null,
        final_package: null,
        error: null,
      })
      .eq('id', existingJobId)
      .select('id, trace_id')
      .single()

    if (resetJob.error) return json({ error: resetJob.error.message }, 500)

    // 기존 scenes/assets 삭제 (깔끔한 재시작)
    await service.from('ytg_scenes').delete().eq('job_id', existingJobId)
    await service.from('ytg_assets').delete().eq('job_id', existingJobId)

    jobId = resetJob.data.id as string
    traceId = resetJob.data.trace_id as string
  } else {
    // 새 job 생성
    const insertJob = await service
      .from('ytg_jobs')
      .insert({
        status: 'QUEUED' satisfies JobStatus,
        input: payload,
        autoconfig: null,
        packager: null,
        final_package: null,
        error: null,
      })
      .select('id, trace_id')
      .single()

    if (insertJob.error) return json({ error: insertJob.error.message }, 500)

    jobId = insertJob.data.id as string
    traceId = insertJob.data.trace_id as string
  }

  // 2) background pipeline
  // @ts-ignore - Supabase Edge Runtime provides EdgeRuntime.waitUntil
  const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil
  if (typeof waitUntil === 'function') {
    waitUntil(runPipeline(jobId, traceId, payload))
  } else {
    // fallback: run inline (개발/로컬 환경)
    runPipeline(jobId, traceId, payload)
  }

  const res: TrendStoryStartResponse = { job_id: jobId, trace_id: traceId }
  return json(res, 200)
})


