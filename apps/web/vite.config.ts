import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {}
  const raw = fs.readFileSync(filePath, 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 1) 표준 Vite 방식: .env, .env.local, .env.[mode], ...
  // 2) 추가 지원: dotfile 생성이 제한된 환경을 위해 `apps/web/env.local`도 읽어서 process.env에 주입
  const root = process.cwd()
  const localNoDotEnvPath = path.join(root, 'env.local')
  const localNoDotEnv = parseEnvFile(localNoDotEnvPath)
  for (const [k, v] of Object.entries(localNoDotEnv)) {
    if (process.env[k] === undefined) process.env[k] = v
  }

  // Vite가 mode별 env를 읽도록 호출(defineConfig 내부에서 사용 가능)
  loadEnv(mode, root)

  return {
    plugins: [react()],
  }
})
