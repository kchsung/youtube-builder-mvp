export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export type DbJobRow = {
  id: string
  created_at: string
  status: JobStatus
  input: unknown
  autoconfig: unknown | null
  packager: unknown | null
  final_package: unknown | null
  error: string | null
}

export type DbSceneRow = {
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

export type DbAssetRow = {
  id: string
  job_id: string
  type: 'image' | 'audio' | 'json'
  path: string | null
  url: string | null
  meta: unknown | null
}


