import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { EMPTY_PROJECTS_FILE, type ProjectsFile } from '../shared/projects'

/**
 * Persistence for user projects + their remembered terminals. The renderer
 * owns the state; main just loads/saves the blob at userData/projects.json.
 */

const filePath = (): string => join(app.getPath('userData'), 'projects.json')

export function loadProjects(): ProjectsFile {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), 'utf8')) as ProjectsFile
    if (!Array.isArray(parsed.projects)) return EMPTY_PROJECTS_FILE
    return {
      ...parsed,
      hiddenSessionIds: parsed.hiddenSessionIds ?? [],
      homeTerminals: parsed.homeTerminals ?? []
    }
  } catch {
    return EMPTY_PROJECTS_FILE
  }
}

export function saveProjects(file: ProjectsFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file, null, 2))
}
