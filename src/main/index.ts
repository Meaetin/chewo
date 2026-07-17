import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import chokidar from 'chokidar'
import { CLAUDE_ROOT, CODEX_ROOT, loadSession, scanAll, type Source } from '../shared/adapter'
import { scanCapabilities } from '../shared/capabilities/scan'
import type { CopyDestination, ProjectTarget } from '../shared/capabilities/types'
import { copyAgent, copyMemoryFile, copySkill, readMemoryFile } from './capability-writer'
import { matchSessionToPane, type ProjectsFile } from '../shared/projects'
import { loadProjects, saveProjects } from './projects'
import { safeSend } from './safe-send'
import {
  bindPaneSession,
  createTerminal,
  disposeAllTerminals,
  getUnboundPanes,
  killTerminal,
  nudgeAgentPane,
  resizeTerminal,
  writeTerminal,
  type CreateTerminalOptions
} from './terminals'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Chewo',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts (.mjs) require an unsandboxed renderer
      sandbox: false
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('sessions:list', () => scanAll())

  ipcMain.handle('sessions:get', (_e, ref: { source: Source; filePath: string }) =>
    loadSession(ref.source, ref.filePath)
  )

  ipcMain.handle('terminal:create', (_e, opts: CreateTerminalOptions) => {
    if (!mainWindow) throw new Error('no window')
    return createTerminal(mainWindow, opts)
  })

  ipcMain.on('terminal:input', (_e, { id, data }: { id: number; data: string }) =>
    writeTerminal(id, data)
  )
  ipcMain.on('terminal:resize', (_e, { id, cols, rows }: { id: number; cols: number; rows: number }) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.on('terminal:kill', (_e, { id }: { id: number }) => killTerminal(id))

  ipcMain.handle('capabilities:scan', (_e, projects: ProjectTarget[]) =>
    scanCapabilities(projects)
  )
  ipcMain.handle(
    'capabilities:copySkill',
    (_e, args: { sourceDir: string; destinations: CopyDestination[]; overwrite: boolean }) =>
      copySkill(args.sourceDir, args.destinations, args.overwrite)
  )
  ipcMain.handle(
    'capabilities:copyAgent',
    (_e, args: { sourcePath: string; destinations: CopyDestination[]; overwrite: boolean }) =>
      copyAgent(args.sourcePath, args.destinations, args.overwrite)
  )
  ipcMain.handle(
    'capabilities:copyMemory',
    (_e, args: { sourcePath: string; destinations: CopyDestination[] }) =>
      copyMemoryFile(args.sourcePath, args.destinations)
  )
  ipcMain.handle('capabilities:readMemory', (_e, path: string) => readMemoryFile(path))

  ipcMain.handle('projects:load', () => loadProjects())
  ipcMain.handle('projects:save', (_e, file: ProjectsFile) => saveProjects(file))
  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}

/**
 * Fresh terminals don't tell us their session id. When new session files
 * appear, match them to unbound panes by source + cwd + spawn time and tell
 * the renderer, so the tab can be labeled and persisted as resumable.
 */
function bindNewSessions(): void {
  const panes = getUnboundPanes()
  if (panes.length === 0) return
  const { sessions } = scanAll()
  for (const session of sessions) {
    const pane = matchSessionToPane(panes, session)
    if (!pane) continue
    bindPaneSession(pane.termId, session.id)
    panes.splice(panes.indexOf(pane), 1)
    safeSend(mainWindow, 'terminal:session-bound', {
      id: pane.termId,
      sessionId: session.id,
      title: session.title
    })
    if (panes.length === 0) break
  }
}

function watchSessionStores(): void {
  const watcher = chokidar.watch(
    [CLAUDE_ROOT, join(CODEX_ROOT, 'sessions'), join(CODEX_ROOT, 'session_index.jsonl')],
    { ignoreInitial: true, depth: 4 }
  )

  let timer: NodeJS.Timeout | null = null
  watcher.on('all', () => {
    // Debounce: JSONL files are appended line-by-line during active sessions
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      bindNewSessions()
      safeSend(mainWindow, 'sessions:changed')
    }, 1000)
  })

  app.on('before-quit', () => watcher.close())
}

/**
 * Phase 3 nudge: when a bridge handoff lands in ~/.context-bridge/inbox/,
 * type "check your inbox" into the target agent's most recent pane (user
 * submits — never auto-sent) and toast the renderer.
 */
function watchHandoffInbox(): void {
  const inboxRoot = join(homedir(), '.context-bridge', 'inbox')
  mkdirSync(join(inboxRoot, 'claude'), { recursive: true })
  mkdirSync(join(inboxRoot, 'codex'), { recursive: true })

  const watcher = chokidar.watch(inboxRoot, { ignoreInitial: true, depth: 2 })
  watcher.on('add', (path) => {
    if (!path.endsWith('.json')) return
    const agent = basename(dirname(path))
    if (agent !== 'claude' && agent !== 'codex') return

    let from = ''
    let note = ''
    try {
      const handoff = JSON.parse(readFileSync(path, 'utf8'))
      from = handoff.from ?? ''
      note = (handoff.note ?? '').slice(0, 200)
    } catch {
      /* unreadable — still nudge; check_inbox will surface it */
    }

    const nudged = nudgeAgentPane(agent)
    safeSend(mainWindow, 'handoff:received', { to: agent, from, note, nudged })
  })

  app.on('before-quit', () => watcher.close())
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  watchSessionStores()
  watchHandoffInbox()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disposeAllTerminals()
  app.quit()
})
