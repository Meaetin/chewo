import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import chokidar from 'chokidar'
import {
  CLAUDE_ROOT,
  CODEX_ROOT,
  loadSession,
  scanAll,
  type SessionMeta,
  type Source
} from '../shared/adapter'
import { scanCapabilities } from '../shared/capabilities/scan'
import type { CopyDestination, ProjectTarget } from '../shared/capabilities/types'
import { copyAgent, copyHook, copyMemoryFile, copySkill, readMemoryFile } from './capability-writer'
import { copyMcp } from './mcp-writer'
import { adoptLegacyMcpRoot, MCP_ROOT } from '../shared/mcp-paths'
import { connectMcpServer, disconnectMcpServer, mcpServerStatus, reconcileMcpServer } from './mcp-server'
import type { HookRef, McpRef } from '../shared/capabilities/types'
import { matchSessionToPane, type ProjectsFile } from '../shared/projects'
import {
  createNote,
  createSubject,
  createTopic,
  deleteNoteItem,
  getNotesRoot,
  readNote,
  renameNoteItem,
  scanNotes,
  setNotesRoot,
  writeNote,
  type CreateNoteArgs
} from './notes'
import type { NoteStyle, SttSource } from '../shared/notes'
import {
  copyEntry,
  createEntry,
  deleteEntry,
  disposeAllWatches,
  isFile,
  moveEntry,
  readDir,
  readFile,
  renameEntry,
  revealEntry,
  startWatch,
  stopWatch,
  watchAdd,
  watchRemove,
  writeFile
} from './file-explorer'
import { loadProjects, saveProjects } from './projects'
import { loadSettings, saveSettings } from './settings'
import { listAgentModels } from './agent-models'
import type { AgentId } from '../shared/agents'
import type { SettingsFile } from '../shared/appearance'
import { notesChatCancel, notesChatSend, type NotesChatArgs } from './notes-chat'
import {
  addCard,
  archiveDone,
  assetsDir,
  deleteArchived,
  deleteCard,
  deleteScope,
  emptyArchiveFile,
  loadArchive,
  loadBoard,
  markCardRun,
  moveCard,
  readAsset,
  restoreArchived,
  setTodosWindow,
  todosRootPath,
  updateCard,
  type UpdateCardArgs
} from './todos'
import { GENERAL_SCOPE, projectScopeDir, type TodoStatus } from '../shared/todos'
import { writeScopeIndex } from '../shared/todo-scopes'
import { disposeSidecar, setSttBroadcast, sttStart, sttStop } from './stt'
import { discardRecording, pendingRecordings, recoverRecording } from './recordings'
import { clearDeepgramKey, deepgramKey, hasDeepgramKey, setDeepgramKey } from './credentials'
import { listStreamingModels, verifyKey } from './deepgram'
import { legacyModelsBytes, legacyModelsDir, removeLegacyModels } from './legacy-models'
import type { SttModelInfo, SttStatus } from '../shared/stt'
import { closeHud, disposeTodoVoice, initTodoVoice, updateTodoHotkey } from './todo-voice'
import { structureTranscript, type StructureArgs } from './structure'
import {
  createWorktree,
  listBranches,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  worktreeState,
  worktreeStatus
} from './worktrees'
import {
  disposeAllGitWatches,
  gitCommitDetail,
  gitDiff,
  gitLog,
  gitStatus,
  gitUntrackedFiles,
  startGitWatch,
  stopGitWatch,
  type GitDiffSpec
} from './git'
import { gitBranches, gitCheckout, gitFetch, gitPull, gitPush } from './git-ops'
import {
  disposeVersionWatch,
  getVersionStatus,
  runSelfUpdate,
  watchRepoHead
} from './app-version'
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

// Keep the dev instance's state separate from the installed app's
// (both would otherwise resolve to ~/Library/Application Support/chewo).
if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')}-dev`)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Chewo',
    // User's base color — resize flashes match the theme, not stock graphite
    backgroundColor: loadSettings().appearance.base,
    // Frameless-inset: traffic lights float over the sidebar's top drag strip
    // (the 40px `-webkit-app-region: drag` zone above the workflow switcher).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts (.mjs) require an unsandboxed renderer
      sandbox: false,
      // Chromium's built-in PDF viewer — the editor's .pdf preview iframe
      plugins: true
    }
  })

  // fs and git watches are created on demand by the renderer and closed by its
  // React cleanups — which never run when the page itself goes away. A reload
  // (⌘R, or a dev-server full reload) therefore orphaned every watcher and the
  // fresh page opened its own on top; only quitting ever released them. Reap
  // them here instead: the renderer re-subscribes on mount either way.
  mainWindow.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return
    disposeAllWatches()
    disposeAllGitWatches()
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
  ipcMain.handle(
    'capabilities:copyMcp',
    (_e, args: { ref: McpRef; destinations: CopyDestination[]; overwrite: boolean }) =>
      copyMcp(args.ref, args.destinations, args.overwrite)
  )
  ipcMain.handle(
    'capabilities:copyHook',
    (_e, args: { ref: HookRef; destinations: CopyDestination[] }) =>
      copyHook(args.ref, args.destinations)
  )

  ipcMain.handle('worktree:branches', (_e, projectPath: string) => listBranches(projectPath))
  ipcMain.handle('worktree:list', (_e, projectPath: string) => listWorktrees(projectPath))
  ipcMain.handle(
    'worktree:state',
    (
      _e,
      a: { projectPath: string; worktreePath: string; branch: string; baseCommit?: string }
    ) => worktreeState(a.projectPath, a.worktreePath, a.branch, a.baseCommit)
  )
  ipcMain.handle(
    'worktree:create',
    (_e, a: { projectPath: string; taskName: string; base?: string }) =>
      createWorktree(a.projectPath, a.taskName, a.base)
  )
  ipcMain.handle(
    'worktree:status',
    (_e, a: { projectPath: string; worktreePath: string; branch: string; baseBranch: string }) =>
      worktreeStatus(a.projectPath, a.worktreePath, a.branch, a.baseBranch)
  )
  ipcMain.handle(
    'worktree:merge',
    (_e, a: { projectPath: string; branch: string; expectedTarget: string }) =>
      mergeWorktree(a.projectPath, a.branch, a.expectedTarget)
  )
  ipcMain.handle(
    'worktree:remove',
    (_e, a: { projectPath: string; worktreePath: string; branch: string }) =>
      removeWorktree(a.projectPath, a.worktreePath, a.branch)
  )

  ipcMain.handle('git:status', (_e, root: string) => gitStatus(root))
  ipcMain.handle('git:log', (_e, a: { root: string; limit?: number }) => gitLog(a.root, a.limit))
  ipcMain.handle('git:show', (_e, a: { root: string; hash: string }) =>
    gitCommitDetail(a.root, a.hash)
  )
  ipcMain.handle('git:diff', (_e, a: { root: string; spec: GitDiffSpec }) =>
    gitDiff(a.root, a.spec)
  )
  ipcMain.handle('git:untracked-files', (_e, a: { root: string; dir: string }) =>
    gitUntrackedFiles(a.root, a.dir)
  )
  ipcMain.handle('git:watch', (_e, root: string) => {
    if (!mainWindow) throw new Error('no window')
    return startGitWatch(mainWindow, root)
  })
  ipcMain.on('git:unwatch', (_e, a: { watchId: number }) => stopGitWatch(a.watchId))

  ipcMain.handle('git:branches', (_e, root: string) => gitBranches(root))
  ipcMain.handle('git:checkout', (_e, a: { root: string; ref: string; create?: boolean }) =>
    gitCheckout(a)
  )
  ipcMain.handle('git:fetch', (_e, root: string) => gitFetch(root))
  ipcMain.handle('git:pull', (_e, root: string) => gitPull(root))
  ipcMain.handle('git:push', (_e, a: { root: string; setUpstream?: boolean }) => gitPush(a))

  ipcMain.handle('notes:scan', () => scanNotes())
  ipcMain.handle('notes:read', (_e, path: string) => readNote(path))
  ipcMain.handle('notes:write', (_e, a: { path: string; content: string }) =>
    writeNote(a.path, a.content)
  )
  ipcMain.handle('notes:createSubject', (_e, name: string) => createSubject(name))
  ipcMain.handle('notes:createTopic', (_e, a: { subject: string; name: string }) =>
    createTopic(a.subject, a.name)
  )
  ipcMain.handle('notes:createNote', (_e, args: CreateNoteArgs) => createNote(args))
  ipcMain.handle('notes:rename', (_e, a: { path: string; newName: string }) =>
    renameNoteItem(a.path, a.newName)
  )
  ipcMain.handle('notes:delete', (_e, path: string) => deleteNoteItem(path))
  ipcMain.handle('notes:structure', (_e, args: StructureArgs) => structureTranscript(args))

  ipcMain.handle('todos:board', (_e, scopeDir: string) => loadBoard(scopeDir))
  ipcMain.handle(
    'todos:addCard',
    (_e, a: { scopeDir: string; title: string; status?: TodoStatus }) =>
      addCard(a.scopeDir, a.title, a.status)
  )
  ipcMain.handle(
    'todos:moveCard',
    (_e, a: { scopeDir: string; cardId: string; to: TodoStatus }) =>
      moveCard(a.scopeDir, a.cardId, a.to)
  )
  ipcMain.handle('todos:updateCard', (_e, args: UpdateCardArgs) => updateCard(args))
  ipcMain.handle('todos:deleteCard', (_e, a: { scopeDir: string; cardId: string }) =>
    deleteCard(a.scopeDir, a.cardId)
  )
  ipcMain.handle('todos:archiveDone', (_e, scopeDir: string) => archiveDone(scopeDir))
  ipcMain.handle('todos:archive', (_e, scopeDir: string) => loadArchive(scopeDir))
  ipcMain.handle('todos:restoreArchived', (_e, a: { scopeDir: string; cardId: string }) =>
    restoreArchived(a.scopeDir, a.cardId)
  )
  ipcMain.handle('todos:deleteArchived', (_e, a: { scopeDir: string; cardId: string }) =>
    deleteArchived(a.scopeDir, a.cardId)
  )
  ipcMain.handle('todos:emptyArchive', (_e, scopeDir: string) => emptyArchiveFile(scopeDir))
  ipcMain.handle('todos:deleteScope', (_e, scopeDir: string) => deleteScope(scopeDir))
  ipcMain.handle('todos:assetsDir', (_e, scopeDir: string) => assetsDir(scopeDir))
  ipcMain.handle('todos:markRun', (_e, a: { scopeDir: string; cardId: string }) =>
    markCardRun(a.scopeDir, a.cardId)
  )
  ipcMain.handle('todos:readAsset', (_e, a: { scopeDir: string; fileName: string }) =>
    readAsset(a.scopeDir, a.fileName)
  )

  ipcMain.on(
    'stt:start',
    (
      _e,
      {
        source,
        lessonPath,
        style
      }: { source?: SttSource; lessonPath?: string; style?: NoteStyle }
    ) => {
      const win = mainWindow
      if (!win) return
      const err = sttStart('notes', (ev) => safeSend(win, 'stt:event', ev), source ?? 'mic', {
        lessonPath,
        style
      })
      if (err) safeSend(win, 'stt:event', { event: 'error', message: err })
    }
  )
  ipcMain.on('stt:stop', () => sttStop())

  ipcMain.handle(
    'stt:status',
    (): SttStatus => ({
      hasKey: hasDeepgramKey(),
      pendingRecoveries: pendingRecordings().map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        durationS: r.durationS,
        bytes: r.bytes,
        lessonPath: r.lessonPath
      }))
    })
  )
  ipcMain.handle('stt:setKey', (_e, key: string) => setDeepgramKey(key))
  ipcMain.handle('stt:clearKey', () => clearDeepgramKey())
  /** Doubles as the model-catalog fetch, so one round trip proves the key. */
  ipcMain.handle('stt:testKey', (_e, key?: string) => verifyKey(key || (deepgramKey() ?? '')))
  ipcMain.handle('stt:models', async (): Promise<SttModelInfo[]> => {
    const key = deepgramKey()
    if (!key) return []
    try {
      return await listStreamingModels(key)
    } catch {
      // Offline or a bad key: the picker falls back to the default rather
      // than showing an empty list the user can't act on.
      return []
    }
  })
  ipcMain.handle('stt:recover', async (_e, id: string) => {
    const key = deepgramKey()
    if (!key) return { ok: false, error: 'Add a Deepgram API key first.' }
    return recoverRecording(id, key)
  })
  ipcMain.handle('stt:discardRecording', (_e, id: string) => discardRecording(id))
  ipcMain.handle('stt:legacyModels', () => ({
    dir: legacyModelsDir(),
    bytes: legacyModelsBytes()
  }))
  ipcMain.handle('stt:removeLegacyModels', () => removeLegacyModels())

  ipcMain.on('noteschat:send', (_e, args: NotesChatArgs) => {
    if (mainWindow) notesChatSend(mainWindow, args)
  })
  ipcMain.on('noteschat:cancel', () => notesChatCancel())

  ipcMain.handle('fs:readDir', (_e, path: string) => readDir(path))
  ipcMain.handle('fs:readFile', (_e, path: string) => readFile(path))
  ipcMain.handle('fs:isFile', (_e, path: string) => isFile(path))
  ipcMain.handle('fs:writeFile', (_e, a: { path: string; content: string }) =>
    writeFile(a.path, a.content)
  )
  ipcMain.handle('fs:rename', (_e, a: { path: string; newName: string }) =>
    renameEntry(a.path, a.newName)
  )
  ipcMain.handle('fs:delete', (_e, path: string) => deleteEntry(path))
  ipcMain.handle('fs:copy', (_e, a: { srcPath: string; destDir: string }) =>
    copyEntry(a.srcPath, a.destDir)
  )
  ipcMain.handle('fs:move', (_e, a: { srcPath: string; destDir: string }) =>
    moveEntry(a.srcPath, a.destDir)
  )
  ipcMain.handle('fs:create', (_e, a: { dirPath: string; name: string; isDir: boolean }) =>
    createEntry(a.dirPath, a.name, a.isDir)
  )
  ipcMain.handle('fs:reveal', (_e, path: string) => revealEntry(path))
  ipcMain.handle('fs:watch', () => {
    if (!mainWindow) throw new Error('no window')
    return startWatch(mainWindow)
  })
  ipcMain.on('fs:watchAdd', (_e, a: { watchId: number; path: string }) =>
    watchAdd(a.watchId, a.path)
  )
  ipcMain.on('fs:watchRemove', (_e, a: { watchId: number; path: string }) =>
    watchRemove(a.watchId, a.path)
  )
  ipcMain.on('fs:unwatch', (_e, a: { watchId: number }) => stopWatch(a.watchId))

  ipcMain.handle('projects:load', () => loadProjects())
  ipcMain.handle('projects:save', (_e, file: ProjectsFile) => {
    saveProjects(file)
    publishScopeIndex(file)
    // Hotkey edits take effect immediately; failure surfaces as a toast
    const err = updateTodoHotkey(file.todoHotkey)
    if (err) safeSend(mainWindow, 'app:toast', err)
  })
  ipcMain.handle('agents:models', (_e, agent: AgentId) => listAgentModels(agent))
  ipcMain.handle('mcp:status', () => mcpServerStatus())
  ipcMain.handle('mcp:connect', (_e, agent: AgentId) => connectMcpServer(agent))
  ipcMain.handle('mcp:disconnect', (_e, agent: AgentId) => disconnectMcpServer(agent))
  ipcMain.handle('settings:load', () => loadSettings())
  ipcMain.handle('settings:save', (_e, file: SettingsFile) => {
    saveSettings(file)
    // Native chrome behind the renderer follows the theme immediately
    mainWindow?.setBackgroundColor(file.appearance.base)
  })
  ipcMain.handle('version:get', () => getVersionStatus())
  ipcMain.on('version:update', () => {
    if (mainWindow) runSelfUpdate(mainWindow)
  })
  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Add Project'
    })
    return result.canceled ? null : result.filePaths[0]
  })
}

/**
 * Fresh terminals don't tell us their session id. When new session files
 * appear, match them to unbound panes by source + cwd + spawn time and tell
 * the renderer, so the tab can be labeled and persisted as resumable.
 */
function bindNewSessions(sessions: SessionMeta[]): void {
  const panes = getUnboundPanes()
  if (panes.length === 0) return
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

/**
 * Claude keeps session transcripts directly inside each project dir, so depth 1
 * covers them — anything deeper is subagent transcripts and memory, which can
 * never change the session list and used to wake a full rescan. Codex nests its
 * rollouts under sessions/YYYY/MM/DD, so that root keeps the deeper reach.
 */
function watchSessionStores(): void {
  const watchers = [
    chokidar.watch(CLAUDE_ROOT, { ignoreInitial: true, depth: 1 }),
    chokidar.watch([join(CODEX_ROOT, 'sessions'), join(CODEX_ROOT, 'session_index.jsonl')], {
      ignoreInitial: true,
      depth: 4
    })
  ]

  let timer: NodeJS.Timeout | null = null
  const onChange = (): void => {
    // Debounce: JSONL files are appended line-by-line during active sessions
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      // One scan serves both consumers — the renderer gets the result on the
      // event rather than invoking sessions:list and paying for a second one
      const result = scanAll()
      bindNewSessions(result.sessions)
      safeSend(mainWindow, 'sessions:changed', result)
    }, 1000)
  }

  for (const watcher of watchers) watcher.on('all', onChange)
  app.on('before-quit', () => {
    for (const watcher of watchers) void watcher.close()
  })
}

/** Same pattern as the session stores: any change under the notes root → rescan. */
function watchNotesStore(): void {
  const watcher = chokidar.watch(getNotesRoot(), { ignoreInitial: true, depth: 3 })

  let timer: NodeJS.Timeout | null = null
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => safeSend(mainWindow, 'notes:changed'), 400)
  })

  app.on('before-quit', () => watcher.close())
}

/**
 * Mirror the project list into ~/.chewo/todos/scopes.json so out-of-process
 * callers (the MCP server's todo tools) can map a project name or cwd to a
 * board directory — they can't read Electron's userData (SPEC-TODOS §9).
 */
function publishScopeIndex(file: ProjectsFile): void {
  try {
    writeScopeIndex(
      file.projects.map((p) => ({
        dir: projectScopeDir(p.name, p.path),
        name: p.name,
        path: p.path
      }))
    )
  } catch {
    /* index is a convenience — a failed write only costs scope resolution */
  }
}

/**
 * MCP tools and hand-edits write board files from outside this process, so
 * the renderer can't rely on the in-process commit push alone.
 */
function watchTodosStore(): void {
  const watcher = chokidar.watch(todosRootPath(), { ignoreInitial: true, depth: 2 })

  const timers = new Map<string, NodeJS.Timeout>()
  watcher.on('all', (_event, path) => {
    if (!path.endsWith('board.json')) return
    const scopeDir = basename(dirname(path))
    if (scopeDir === GENERAL_SCOPE || scopeDir.startsWith('p-')) {
      clearTimeout(timers.get(scopeDir))
      // Debounce: our own writes fire here too, and JSON.stringify can land
      // as more than one event
      timers.set(
        scopeDir,
        setTimeout(() => safeSend(mainWindow, 'todos:changed', { scopeDir }), 250)
      )
    }
  })

  app.on('before-quit', () => watcher.close())
}

/**
 * Phase 3 nudge: when a handoff lands in ~/.chewo/mcp/inbox/, type "check your
 * inbox" into the target agent's most recent pane (user submits — never
 * auto-sent) and toast the renderer.
 */
function watchHandoffInbox(): void {
  adoptLegacyMcpRoot()
  const inboxRoot = join(MCP_ROOT, 'inbox')
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

/**
 * Custom menu WITHOUT the default zoom roles — ⌘+/− must reach the focused
 * terminal (per-pane font zoom) instead of zooming the whole app.
 */
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

app.whenReady().then(() => {
  const projectsFile = loadProjects()
  if (projectsFile.notesRoot) setNotesRoot(projectsFile.notesRoot)
  buildMenu()
  registerIpc()
  createWindow()
  if (mainWindow) {
    setSttBroadcast((ev) => safeSend(mainWindow, 'stt:event', ev))
    setTodosWindow(mainWindow)
    initTodoVoice(mainWindow, projectsFile.todoHotkey)
    // The hidden HUD window must not keep the app alive after the main
    // window closes — it would swallow 'window-all-closed'
    mainWindow.on('closed', () => closeHud())
  }
  publishScopeIndex(projectsFile)
  if (mainWindow) watchRepoHead(mainWindow)
  watchSessionStores()
  watchNotesStore()
  watchTodosStore()
  watchHandoffInbox()
  // Re-point an existing registration if the app moved or was renamed away
  // from `context-bridge`. Never registers on its own — see mcp-server.ts.
  void reconcileMcpServer()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disposeAllTerminals()
  disposeAllWatches()
  disposeAllGitWatches()
  disposeVersionWatch()
  disposeSidecar()
  disposeTodoVoice()
  app.quit()
})
