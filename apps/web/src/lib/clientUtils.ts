export async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadJson(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  downloadBlob(filename, blob)
}

export async function downloadFileFromUrl(url: string, filename: string) {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    downloadBlob(filename, blob)
  } catch {
    // fallback: open direct (CORS 정책/네트워크 이슈 등)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    a.click()
  }
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function guessExtFromContentType(ct: string | null) {
  const t = (ct ?? '').toLowerCase()
  if (t.includes('image/png')) return 'png'
  if (t.includes('image/jpeg')) return 'jpg'
  if (t.includes('image/webp')) return 'webp'
  if (t.includes('image/gif')) return 'gif'
  return 'png'
}

export async function downloadScenesImagesZip(
  scenes: Array<{ scene_id: number; image_url: string }>,
  zipFilename: string,
  onProgress?: (done: number, total: number) => void,
) {
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const total = scenes.length
  let done = 0

  for (const s of scenes) {
    const res = await fetch(s.image_url, { mode: 'cors' })
    if (!res.ok) throw new Error(`scene ${s.scene_id} download failed: HTTP ${res.status}`)
    const ct = res.headers.get('content-type')
    const ext = guessExtFromContentType(ct)
    const ab = await res.arrayBuffer()
    zip.file(`scene-${pad2(s.scene_id)}.${ext}`, ab)
    done++
    onProgress?.(done, total)
  }

  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(zipFilename, blob)
}


