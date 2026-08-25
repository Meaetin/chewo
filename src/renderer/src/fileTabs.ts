import type { OpenFile } from './App'

export type FileDisposition = 'preview' | 'pinned'

export const openFileTab = (
  openFiles: OpenFile[],
  path: string,
  disposition: FileDisposition
): OpenFile[] => {
  const existing = openFiles.find((file) => file.path === path)
  if (existing) {
    if (disposition === 'pinned' && !existing.pinned)
      return openFiles.map((file) => (file.path === path ? { ...file, pinned: true } : file))
    return openFiles
  }

  const opened: OpenFile = {
    path,
    name: path.split('/').pop() ?? path,
    pinned: disposition === 'pinned'
  }
  if (opened.pinned) return [...openFiles, opened]
  const preview = openFiles.findIndex((file) => !file.pinned)
  if (preview === -1) return [...openFiles, opened]
  const next = [...openFiles]
  next[preview] = opened
  return next
}

export const pinOpenFile = (openFiles: OpenFile[], path: string): OpenFile[] => {
  const target = openFiles.find((file) => file.path === path)
  if (!target || target.pinned) return openFiles
  return openFiles.map((file) => (file.path === path ? { ...file, pinned: true } : file))
}

export const reorderOpenFiles = (
  openFiles: OpenFile[],
  path: string,
  targetPath: string
): OpenFile[] => {
  const fromIndex = openFiles.findIndex((file) => file.path === path)
  const targetIndex = openFiles.findIndex((file) => file.path === targetPath)
  if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) return openFiles

  const reordered = [...openFiles]
  const [movedFile] = reordered.splice(fromIndex, 1)
  reordered.splice(targetIndex, 0, { ...movedFile, pinned: true })
  return reordered
}
