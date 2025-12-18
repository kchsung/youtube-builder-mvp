# Supabase 리소스 (DB + Edge Functions)

이 폴더는 **Supabase Cloud**로 옮겨 적용할 수 있도록,
프로젝트에 필요한 **DB 스키마(SQL)**와 **Edge Functions** 소스를 담습니다.

## 구성

- `migrations/`: DB 테이블/정책 SQL
- `functions/`: Supabase Edge Functions (Deno)

## 적용 순서(권장)

1) `migrations/`의 SQL을 Supabase Dashboard → **SQL Editor**에서 실행
2) `functions/`를 Supabase Dashboard → **Edge Functions**에 업로드/배포
3) Functions 환경변수(Secrets) 설정
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (Storage 업로드/DB 업데이트용)
   - `OPENAI_API_KEY` (텍스트/이미지/TTS 생성용)
   - (선택) `OPENAI_TEXT_MODEL` (기본: `gpt-5.2`, 폴백: `gpt-4o-mini` → `gpt-4o`)
   - (선택) `OPENAI_IMAGE_SIZE` (기본 폴백: `1792x1024` → `1024x1024`)
   - (선택) `OPENAI_IMAGE_TIMEOUT_MS` (기본: `180000` = 3분)
   - (선택) `OPENAI_IMAGE_MAX_ATTEMPTS` (기본: `2`, 최대: `5`)
   - (선택) `YTG_BUCKET` (기본값: `ytg-assets`)

> 참고: 이 레포는 프론트에서 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`를 사용합니다.

## 함수 목록

- `trendstory-start` (POST)
  - 입력: `{ topic_domain, language, audience, input_as_text? }`
  - 동작: `ytg_jobs`에 job 생성 후 `QUEUED` 반환 → 백그라운드(EdgeRuntime.waitUntil)에서
    - LLM로 autoconfig/packager 생성 (packager는 "설명 + DATA(JSON)" 출력도 허용)
    - (가능하면) Responses API의 `web_search_preview` tool로 트렌드 리서치 보강 (실패 시 자동 폴백)
    - 이미지 생성 후 Storage 업로드 + `ytg_scenes.image_url` 업데이트
    - TTS 생성 후 Storage 업로드 + `ytg_assets`/`jobs.final_package` 업데이트
    - 완료 시 `SUCCEEDED`로 마킹
  - 반환: `{ job_id, trace_id? }`

- `trendstory-status` (GET)
  - 쿼리: `?job_id=...`
  - 반환: `{ status, trace_id?, job, scenes?, assets? }`

- `trendstory-jobs` (GET)
  - 쿼리: `?limit=20` (최대 50)
  - 반환: `{ jobs: [{ id, created_at, status, trace_id, input, error }] }`

- `trendstory-retry-images` (POST)
  - 바디: `{ job_id, scene_ids?: number[], missing_only?: boolean }`
  - 동작: `ytg_scenes.image_url`이 비어있는 씬(또는 지정된 scene_ids)만 이미지 재생성 후 DB/Storage 업데이트
  - 반환: `{ job_id, attempted, succeeded, failed, skipped }`

- `trendstory-retry-audio` (POST)
  - 바디: `{ job_id, force?: boolean }`
  - 동작: 씬 narration(또는 packager.tts.full_script)로 TTS를 다시 생성하여 Storage 업로드 후 `ytg_assets`/`final_package.audio_url` 업데이트
  - 반환: `{ job_id, accepted, message }` (백그라운드 실행)

- `trendstory-delete-job` (POST)
  - 바디: `{ job_id }`
  - 동작: (best-effort) Storage의 `ytg-assets/jobs/<job_id>/...` 정리 후 `ytg_jobs` 삭제 (FK로 scenes/assets cascade)
  - 반환: `{ job_id, accepted, message }` (백그라운드 실행)

## Storage (중요)

마이그레이션 SQL은 `ytg-assets` 버킷을 **public=true**로 생성합니다.
- 이미지/오디오는 `ytg-assets/jobs/<job_id>/...` 경로에 저장됩니다.
- 운영에서는 public 대신 signed URL/권한 정책으로 전환을 권장합니다.

## @openai/agents 워크플로우 참고 (중요)

Supabase Edge Functions는 **Deno 런타임**입니다.  
사용자가 공유한 `@openai/agents`(Agent/Runner/webSearchTool) 패턴은 **Node 런타임 전제인 경우가 많아** Edge Function에서 그대로 동작하지 않을 수 있습니다.

현재 구현은 동일한 단계(autoconfig → packager → 이미지 → TTS → final_package)를 따르되,
- packager 단계에서 **가능하면** Responses API의 `web_search_preview` tool을 사용하고,
- 실패하면 **web search 없이** 생성으로 자동 폴백합니다.

## 보안 참고(중요)

현재 `migrations`의 RLS 정책은 **MVP용(anon에도 insert/select/update 허용)** 입니다.
운영에선 아래 중 하나로 잠그는 걸 권장합니다.

- 인증 유저만 접근(Authenticated only)
- `trace_id`를 비밀값처럼 사용하여 조회 제한
- Edge Function에서 Service Role 키로만 쓰기 허용 + 테이블 RLS는 엄격히

## 배포 시 흔한 오류(중요)

Supabase Dashboard에서 개별 함수 업로드로 배포할 때는 번들러가 **상위 폴더 import(`../...`)**를 막는 경우가 있습니다.  
가장 확실한 방법은 **`index.ts` 단일 파일로 구성**하는 것입니다(이 레포의 `trendstory-*`는 단일 파일로도 동작).



