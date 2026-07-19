import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { homedir } from 'node:os'
import type {
  CreateWorktreeResult,
  MergeWorktreeResult,
  RemoveWorktreeResult,
  WorktreeStatusResult
} from '../main/worktrees'
import type { NotesOpResult } from '../main/notes'
import type {
  FileOpResult,
  FsChangedEvent,
  ReadDirResult,
  ReadFileResult,
  WriteFileResult
} from '../main/file-explorer'
import type { StructureArgs, StructureResult } from '../main/structure'
import type { NotesTree, SttEvent } from '../shared/notes'
import type { SettingsFile } from '../shared/appearance'
import type { BoardFile, HudState, TodoStatus } from '../shared/todos'

export interface TermDataEvent {
  id: number
  data: string
}
export interface TermExitEvent {
  id: number
  exitCode: number
}
export interface TermBoundEvent {
  id: number
  sessionId: string
  title: string
}
export interface HandoffEvent {
  to: 'claude' | 'codex'
  from: string
  note: string
  /** false when no live pane of the target agent existed to type into */
  nudged: boolean
}

/**
 * One `ipcRenderer` listener per channel, fanned out to every subscriber. Panes
 * subscribe to `terminal:data`/`terminal:exit` individually, so a naive
 * on/removeListener per pane grows the emitter's listener count with the number
 * of open terminals and trips Node's default 10-listener leak warning. This
 * keeps it at exactly one listener per channel regardless of terminal count.
 */
function channelFanout<T>(channel: string): (cb: (e: T) => void) => () => void {
  const subs = new Set<(e: T) => void>()
  const listener = (_e: IpcRendererEvent, payload: T): void => {
    for (const cb of subs) cb(payload)
  }
  return (cb) => {
    if (subs.size === 0) ipcRenderer.on(channel, listener)
    subs.add(cb)
    return () => {
      subs.delete(cb)
      if (subs.size === 0) ipcRenderer.removeListener(channel, listener)
    }
  }
}

const onTermData = channelFanout<TermDataEvent>('terminal:data')
const onTermExit = channelFanout<TermExitEvent>('terminal:exit')

const api = {
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSession: (ref: { source: string; filePath: string }) =>
    ipcRenderer.invoke('sessions:get', ref),
  onSessionsChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('sessions:changed', listener)
    return () => ipcRenderer.removeListener('sessions:changed', listener)
  },

  createTerminal: (opts: {
    source: string
    sessionId?: string
    cwd?: string | null
    setupCommand?: string
    runCommand?: string
    permissionMode?: string
    approvalPolicy?: string
  }) => ipcRenderer.invoke('terminal:create', opts) as Promise<number>,
  termInput: (id: number, data: string) => ipcRenderer.send('terminal:input', { id, data }),
  termResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),
  termKill: (id: number) => ipcRenderer.send('terminal:kill', { id }),
  onTermData,
  onTermExit,
  onTermBound: (cb: (e: TermBoundEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: TermBoundEvent): void => cb(payload)
    ipcRenderer.on('terminal:session-bound', listener)
    return () => ipcRenderer.removeListener('terminal:session-bound', listener)
  },

  onHandoff: (cb: (e: HandoffEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: HandoffEvent): void => cb(payload)
    ipcRenderer.on('handoff:received', listener)
    return () => ipcRenderer.removeListener('handoff:received', listener)
  },

  homeDir: homedir(),
  scanCapabilities: (projects: Array<{ id: string; name: string; path: string }>) =>
    ipcRenderer.invoke('capabilities:scan', projects),
  copySkill: (args: { sourceDir: string; destinations: unknown[]; overwrite: boolean }) =>
    ipcRenderer.invoke('capabilities:copySkill', args),
  copyAgent: (args: { sourcePath: string; destinations: unknown[]; overwrite: boolean }) =>
    ipcRenderer.invoke('capabilities:copyAgent', args),
  copyMemory: (args: { sourcePath: string; destinations: unknown[] }) =>
    ipcRenderer.invoke('capabilities:copyMemory', args),
  readMemory: (path: string) => ipcRenderer.invoke('capabilities:readMemory', path) as Promise<string>,
  copyMcp: (args: { ref: unknown; destinations: unknown[]; overwrite: boolean }) =>
    ipcRenderer.invoke('capabilities:copyMcp', args),
  copyHook: (args: { ref: unknown; destinations: unknown[] }) =>
    ipcRenderer.invoke('capabilities:copyHook', args),
  createWorktree: (args: { projectPath: string; taskName: string }) =>
    ipcRenderer.invoke('worktree:create', args) as Promise<CreateWorktreeResult>,
  worktreeStatus: (args: { projectPath: string; worktreePath: string; branch: string }) =>
    ipcRenderer.invoke('worktree:status', args) as Promise<WorktreeStatusResult>,
  worktreeMerge: (args: { projectPath: string; branch: string }) =>
    ipcRenderer.invoke('worktree:merge', args) as Promise<MergeWorktreeResult>,
  worktreeRemove: (args: { projectPath: string; worktreePath: string; branch: string }) =>
    ipcRenderer.invoke('worktree:remove', args) as Promise<RemoveWorktreeResult>,
  notesScan: () => ipcRenderer.invoke('notes:scan') as Promise<NotesTree>,
  notesRead: (path: string) => ipcRenderer.invoke('notes:read', path) as Promise<string>,
  notesWrite: (path: string, content: string) =>
    ipcRenderer.invoke('notes:write', { path, content }) as Promise<void>,
  notesCreateSubject: (name: string) =>
    ipcRenderer.invoke('notes:createSubject', name) as Promise<NotesOpResult>,
  notesCreateTopic: (subject: string, name: string) =>
    ipcRenderer.invoke('notes:createTopic', { subject, name }) as Promise<NotesOpResult>,
  notesCreateNote: (args: {
    subject: string
    topic: string
    title: string
    body?: string
    source?: string
  }) => ipcRenderer.invoke('notes:createNote', args) as Promise<NotesOpResult>,
  notesDelete: (path: string) => ipcRenderer.invoke('notes:delete', path) as Promise<NotesOpResult>,
  onNotesChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('notes:changed', listener)
    return () => ipcRenderer.removeListener('notes:changed', listener)
  },
  sttStart: (model: string) => ipcRenderer.send('stt:start', { model }),
  sttStop: () => ipcRenderer.send('stt:stop'),
  sttPrewarm: (model: string) => ipcRenderer.send('stt:prewarm', { model }),
  onSttEvent: (cb: (e: SttEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: SttEvent): void => cb(payload)
    ipcRenderer.on('stt:event', listener)
    return () => ipcRenderer.removeListener('stt:event', listener)
  },
  notesStructure: (args: StructureArgs) =>
    ipcRenderer.invoke('notes:structure', args) as Promise<StructureResult>,
  notesChatSend: (args: { scopePath: string; message: string; resumeSessionId?: string }) =>
    ipcRenderer.send('noteschat:send', args),
  notesChatCancel: () => ipcRenderer.send('noteschat:cancel'),
  onNotesChatEvent: (cb: (e: Record<string, unknown>) => void) => {
    const listener = (_e: IpcRendererEvent, payload: Record<string, unknown>): void => cb(payload)
    ipcRenderer.on('noteschat:event', listener)
    return () => ipcRenderer.removeListener('noteschat:event', listener)
  },

  todosBoard: (scopeDir: string) => ipcRenderer.invoke('todos:board', scopeDir) as Promise<BoardFile>,
  todosAddCard: (args: { scopeDir: string; title: string; status?: TodoStatus }) =>
    ipcRenderer.invoke('todos:addCard', args) as Promise<BoardFile>,
  todosMoveCard: (args: { scopeDir: string; cardId: string; to: TodoStatus }) =>
    ipcRenderer.invoke('todos:moveCard', args) as Promise<BoardFile>,
  todosUpdateCard: (args: {
    scopeDir: string
    cardId: string
    title: string
    text: string
    addImages: string[]
    removeImages: string[]
  }) => ipcRenderer.invoke('todos:updateCard', args) as Promise<BoardFile>,
  todosDeleteCard: (args: { scopeDir: string; cardId: string }) =>
    ipcRenderer.invoke('todos:deleteCard', args) as Promise<BoardFile>,
  todosClearDone: (scopeDir: string) =>
    ipcRenderer.invoke('todos:clearDone', scopeDir) as Promise<BoardFile>,
  todosReadAsset: (args: { scopeDir: string; fileName: string }) =>
    ipcRenderer.invoke('todos:readAsset', args) as Promise<string | null>,
  onTodosChanged: (cb: (e: { scopeDir: string }) => void) => {
    const listener = (_e: IpcRendererEvent, payload: { scopeDir: string }): void => cb(payload)
    ipcRenderer.on('todos:changed', listener)
    return (): void => {
      ipcRenderer.removeListener('todos:changed', listener)
    }
  },

  fsReadDir: (path: string) => ipcRenderer.invoke('fs:readDir', path) as Promise<ReadDirResult>,
  fsReadFile: (path: string) => ipcRenderer.invoke('fs:readFile', path) as Promise<ReadFileResult>,
  fsIsFile: (path: string) => ipcRenderer.invoke('fs:isFile', path) as Promise<boolean>,
  fsWriteFile: (args: { path: string; content: string }) =>
    ipcRenderer.invoke('fs:writeFile', args) as Promise<WriteFileResult>,
  fsRename: (args: { path: string; newName: string }) =>
    ipcRenderer.invoke('fs:rename', args) as Promise<FileOpResult>,
  fsDelete: (path: string) => ipcRenderer.invoke('fs:delete', path) as Promise<FileOpResult>,
  fsCopy: (args: { srcPath: string; destDir: string }) =>
    ipcRenderer.invoke('fs:copy', args) as Promise<FileOpResult>,
  fsWatch: () => ipcRenderer.invoke('fs:watch') as Promise<number>,
  fsWatchAdd: (watchId: number, path: string) =>
    ipcRenderer.send('fs:watchAdd', { watchId, path }),
  fsWatchRemove: (watchId: number, path: string) =>
    ipcRenderer.send('fs:watchRemove', { watchId, path }),
  fsUnwatch: (watchId: number) => ipcRenderer.send('fs:unwatch', { watchId }),
  onFsChanged: (cb: (e: FsChangedEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: FsChangedEvent): void => cb(payload)
    ipcRenderer.on('fs:changed', listener)
    return (): void => {
      ipcRenderer.removeListener('fs:changed', listener)
    }
  },

  // Voice HUD window (SPEC-TODOS §6)
  onHudState: (cb: (state: HudState) => void) => {
    const listener = (_e: IpcRendererEvent, payload: HudState): void => cb(payload)
    ipcRenderer.on('hud:state', listener)
    return (): void => {
      ipcRenderer.removeListener('hud:state', listener)
    }
  },
  hudAction: (action: 'stop' | 'undo' | 'dismiss' | 'hover-in' | 'hover-out') =>
    ipcRenderer.send('hud:action', action),
  hudResize: (height: number) => ipcRenderer.send('hud:resize', height),
  onAppToast: (cb: (message: string) => void) => {
    const listener = (_e: IpcRendererEvent, payload: string): void => cb(payload)
    ipcRenderer.on('app:toast', listener)
    return (): void => {
      ipcRenderer.removeListener('app:toast', listener)
    }
  },

  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (file: unknown) => ipcRenderer.invoke('projects:save', file),
  loadSettings: () => ipcRenderer.invoke('settings:load') as Promise<SettingsFile>,
  saveSettings: (file: SettingsFile) => ipcRenderer.invoke('settings:save', file) as Promise<void>,
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
