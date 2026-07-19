import type { OpenFile } from './App'

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
  reordered.splice(targetIndex, 0, movedFile)
  return reordered
}
