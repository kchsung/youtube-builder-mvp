-- youtube-generator: per-scene image generation lock/status (for concurrent Edge Function calls)
-- 실행 위치: Supabase Dashboard -> SQL Editor

alter table public.ytg_scenes
add column if not exists image_gen_status text;

alter table public.ytg_scenes
add column if not exists image_gen_request_id uuid;

alter table public.ytg_scenes
add column if not exists image_gen_started_at timestamptz;

alter table public.ytg_scenes
add column if not exists image_gen_error text;

create index if not exists ytg_scenes_image_gen_status_idx on public.ytg_scenes (job_id, image_gen_status);


