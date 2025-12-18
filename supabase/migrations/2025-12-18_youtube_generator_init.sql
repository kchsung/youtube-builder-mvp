-- youtube-generator: minimal schema for jobs/scenes/assets used by the web app
-- 실행 위치: Supabase Dashboard -> SQL Editor

-- Extensions
create extension if not exists pgcrypto;

-- Storage bucket (이미지/오디오 저장용)
-- 주의: Supabase 프로젝트에 Storage가 활성화되어 있어야 합니다.
insert into storage.buckets (id, name, public)
values ('ytg-assets', 'ytg-assets', true)
on conflict (id) do nothing;

-- 1) Jobs
create table if not exists public.ytg_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  input jsonb not null,
  autoconfig jsonb,
  packager jsonb,
  final_package jsonb,
  error text,
  trace_id uuid not null default gen_random_uuid()
);

create index if not exists ytg_jobs_created_at_idx on public.ytg_jobs (created_at desc);
create index if not exists ytg_jobs_status_idx on public.ytg_jobs (status);

-- 2) Scenes
create table if not exists public.ytg_scenes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ytg_jobs(id) on delete cascade,
  scene_id int not null,
  narration text,
  on_screen_text text,
  visual_brief text,
  mood text,
  duration_sec int,
  image_prompt text,
  image_path text,
  image_url text
);

create index if not exists ytg_scenes_job_id_idx on public.ytg_scenes (job_id);
create unique index if not exists ytg_scenes_job_scene_unique on public.ytg_scenes (job_id, scene_id);

-- 3) Assets
create table if not exists public.ytg_assets (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.ytg_jobs(id) on delete cascade,
  type text not null check (type in ('image','audio','json')),
  path text,
  url text,
  meta jsonb
);

create index if not exists ytg_assets_job_id_idx on public.ytg_assets (job_id);
create index if not exists ytg_assets_type_idx on public.ytg_assets (type);

-- RLS
alter table public.ytg_jobs enable row level security;
alter table public.ytg_scenes enable row level security;
alter table public.ytg_assets enable row level security;

-- MVP 정책: anon(=브라우저)에서도 job 생성/조회 가능하게 오픈
-- 운영에서는 인증/레이트리밋/trace_id 기반 제한 등을 권장합니다.

drop policy if exists "ytg_jobs_select_all" on public.ytg_jobs;
create policy "ytg_jobs_select_all"
on public.ytg_jobs
for select
to anon, authenticated
using (true);

drop policy if exists "ytg_jobs_insert_all" on public.ytg_jobs;
create policy "ytg_jobs_insert_all"
on public.ytg_jobs
for insert
to anon, authenticated
with check (true);

drop policy if exists "ytg_jobs_update_all" on public.ytg_jobs;
create policy "ytg_jobs_update_all"
on public.ytg_jobs
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "ytg_scenes_select_all" on public.ytg_scenes;
create policy "ytg_scenes_select_all"
on public.ytg_scenes
for select
to anon, authenticated
using (true);

drop policy if exists "ytg_scenes_insert_all" on public.ytg_scenes;
create policy "ytg_scenes_insert_all"
on public.ytg_scenes
for insert
to anon, authenticated
with check (true);

drop policy if exists "ytg_scenes_update_all" on public.ytg_scenes;
create policy "ytg_scenes_update_all"
on public.ytg_scenes
for update
to anon, authenticated
using (true)
with check (true);

drop policy if exists "ytg_assets_select_all" on public.ytg_assets;
create policy "ytg_assets_select_all"
on public.ytg_assets
for select
to anon, authenticated
using (true);

drop policy if exists "ytg_assets_insert_all" on public.ytg_assets;
create policy "ytg_assets_insert_all"
on public.ytg_assets
for insert
to anon, authenticated
with check (true);

drop policy if exists "ytg_assets_update_all" on public.ytg_assets;
create policy "ytg_assets_update_all"
on public.ytg_assets
for update
to anon, authenticated
using (true)
with check (true);


