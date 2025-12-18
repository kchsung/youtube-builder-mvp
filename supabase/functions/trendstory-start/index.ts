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
    return JSON.parse(stripJsonFences(s))
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
      return JSON.parse(candidate)
    }
  }
  throw new Error('Failed to parse JSON object from output')
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
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
  const envSize = Deno.env.get('OPENAI_IMAGE_SIZE')?.trim()
  const sizes = Array.from(new Set([envSize, '1792x1024', '1024x1024'].filter(Boolean))) as string[]

  let lastErr: unknown = null
  for (const size of sizes) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        size,
      }),
    })
    const text = await res.text()
    if (!res.ok) {
      lastErr = new Error(`OpenAI image error (${res.status}): ${text}`)
      // size/param 이슈면 다음 size로 재시도
      if (res.status === 400) continue
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
      const imgRes = await fetch(url)
      if (!imgRes.ok) throw new Error(`Failed to fetch image URL (${imgRes.status})`)
      const ab = await imgRes.arrayBuffer()
      return new Uint8Array(ab)
    }

    throw new Error('OpenAI image returned neither b64_json nor url')
  }

  throw lastErr ?? new Error('OpenAI image error: no valid size worked')
}

async function openaiTtsMp3(input: string): Promise<Uint8Array> {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mp3',
      input,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI TTS error (${res.status}): ${await res.text()}`)
  const ab = await res.arrayBuffer()
  return new Uint8Array(ab)
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
  const bucket = Deno.env.get('YTG_BUCKET') ?? 'ytg-assets'

  try {
    await supabase.from('ytg_jobs').update({ status: 'RUNNING' satisfies JobStatus, error: null }).eq('id', jobId)

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

    const autoconfig = await openaiResponsesJson<AutoConfigOutput>({
      model: 'gpt-5.2',
      input: [
        { role: 'system', content: autoconfigInstructions },
        { role: 'user', content: autoconfigInput },
      ],
    })

    await supabase.from('ytg_jobs').update({ autoconfig }).eq('id', jobId)

    // ---- 1) TrendStory Packager Agent ----
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
- 사람이 읽는 설명 + 마지막에 DATA(JSON) 1블록.
- DATA에는 trend_research, story, scenes, style_guide, image_prompts, tts, video_package, youtube_meta 키를 포함.`

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

    let packager: PackagerOutput
    try {
      // 1차 시도: Responses API + web_search_preview tool
      // (Deno Edge에서 @openai/agents를 직접 실행하기 어려워, API 레벨로 web search를 사용)
      packager = await openaiResponsesJson<PackagerOutput>({
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
    } catch {
      // fallback: web search 없이 생성 (모델은 gpt-5.2 유지)
      packager = await openaiResponsesJson<PackagerOutput>({
        model: 'gpt-5.2',
        input: [
          { role: 'system', content: packagerInstructions },
          { role: 'user', content: JSON.stringify(packagerInputObj) },
        ],
      })
    }

    pushRuntimeLog(packager, 'info', 'packager 생성 완료', {
      has_image_render_requests: Array.isArray(packager?.image_render_requests),
      image_render_requests_len: Array.isArray(packager?.image_render_requests) ? packager.image_render_requests.length : 0,
      has_image_prompts: Array.isArray(packager?.image_prompts),
      image_prompts_len: Array.isArray(packager?.image_prompts) ? packager.image_prompts.length : 0,
    })

    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

    const targetCount = Math.max(1, Math.min(Number(autoconfig.scene_count ?? 6) || 6, 12))
    const scenes = (packager.scenes ?? [])
      .slice(0, targetCount)
      .map((s, i) => ({ ...s, scene_id: Number.isFinite(s.scene_id) ? s.scene_id : i + 1 }))
      .sort((a, b) => a.scene_id - b.scene_id)

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

    const assetRows: Array<Omit<DbAssetRow, 'id'>> = []

    // 2) TTS (single track) - 오디오를 먼저 생성한다.
    const narrationText =
      String(packager?.tts?.full_script ?? '').trim() ||
      scenes
        .map((s) => s.narration?.trim())
        .filter(Boolean)
        .map((t, i) => `${i + 1}. ${t}`)
        .join('\n')

    let audioUrl: string | null = null
    if (narrationText.trim().length > 0) {
      try {
        pushRuntimeLog(packager, 'info', 'TTS 생성 시작', { chars: narrationText.length })
        const mp3 = await openaiTtsMp3(narrationText)
        const audioPath = `jobs/${jobId}/narration.mp3`
        const upA = await supabase.storage.from(bucket).upload(audioPath, new Blob([toArrayBuffer(mp3)], { type: 'audio/mpeg' }), {
          contentType: 'audio/mpeg',
          upsert: true,
        })
        if (upA.error) throw new Error(upA.error.message)
        audioUrl = supabase.storage.from(bucket).getPublicUrl(audioPath).data.publicUrl
        assetRows.push({
          job_id: jobId,
          type: 'audio',
          path: audioPath,
          url: audioUrl,
          meta: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
        })
        pushRuntimeLog(packager, 'info', 'TTS 생성 완료', { audio_url: audioUrl })
      } catch (e: any) {
        const msg = e?.message ?? String(e)
        pushRuntimeLog(packager, 'error', 'TTS 생성 실패 - 오디오 없이 계속 진행합니다.', { error: msg })
        audioUrl = null
      }
    } else {
      pushRuntimeLog(packager, 'error', 'TTS 스크립트가 비어 있어 오디오 생성을 건너뜁니다.', {
        hint: 'packager.tts.full_script 또는 scenes[n].narration이 비어있습니다.',
      })
    }

    // 3) per-scene image generation + upload + update rows (오디오 이후)
    const validSceneIds = new Set(scenes.map((s) => s.scene_id))
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
    let imagesSuccess = 0
    let imagesFailed = 0
    let imagesSkipped = 0
    const imagesErrors: Array<{ scene_id?: number; error: string }> = []

    if (norm.requests.length === 0) {
      pushRuntimeLog(packager, 'error', 'image_render_requests가 0개라 이미지 생성을 건너뜁니다.', {
        hint: 'packager가 image_render_requests/image_prompts를 비웠거나 scenes/scene_id 매핑이 깨졌습니다.',
      })
      imagesSkipped = scenes.length
    } else {
      for (const r of norm.requests) {
        const sceneId = Number((r as any)?.scene_id)
        const prompt = String((r as any)?.prompt ?? '').trim()
        if (!Number.isFinite(sceneId) || !validSceneIds.has(sceneId) || !prompt) {
          imagesSkipped++
          continue
        }

        try {
          pushRuntimeLog(packager, 'info', '이미지 생성 시작', { scene_id: sceneId })
          const png = await openaiImagePng(prompt)
          const path = `jobs/${jobId}/scene-${String(sceneId).padStart(2, '0')}-${safeFilename(payload.topic_domain).slice(0, 48)}.png`
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

          assetRows.push({
            job_id: jobId,
            type: 'image',
            path,
            url: publicUrl,
            meta: { scene_id: sceneId, prompt, requested_size: (r as any)?.size ?? null },
          })
          imagesSuccess++
          pushRuntimeLog(packager, 'info', '이미지 생성 완료', { scene_id: sceneId })
        } catch (e: any) {
          imagesFailed++
          const msg = e?.message ?? String(e)
          imagesErrors.push({ scene_id: sceneId, error: msg })
          pushRuntimeLog(packager, 'error', '이미지 생성 실패', { scene_id: sceneId, error: msg })
        }
      }
    }

    const rt = ensureRuntime(packager)
    rt.images_success = imagesSuccess
    rt.images_failed = imagesFailed
    rt.images_skipped = imagesSkipped
    rt.images_errors = imagesErrors
    await supabase.from('ytg_jobs').update({ packager }).eq('id', jobId)

    // 4) assets insert
    assetRows.push({
      job_id: jobId,
      type: 'json',
      path: null,
      url: null,
      meta: { note: 'final_package is stored in jobs.final_package', trace_id: traceId },
    })
    const insAssets = await supabase.from('ytg_assets').insert(assetRows)
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
        tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy' },
      },
      meta: { storage_bucket: bucket, supabase_url: supabaseUrl, trace_id: traceId },
    }

    const updJob = await supabase
      .from('ytg_jobs')
      .update({ status: 'SUCCEEDED' satisfies JobStatus, final_package, error: null })
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

  // 1) create job (QUEUED)
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

  const jobId = insertJob.data.id as string
  const traceId = insertJob.data.trace_id as string

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


