import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { homedir } from 'node:os'
import type {
  CreateWorktreeResult,
  MergeWorktreeResult,
  RemoveWorktreeResult,
  WorktreeStatusResult
} from '../main/worktrees'

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
    permissionMode?: string
    approvalPolicy?: string
  }) => ipcRenderer.invoke('terminal:create', opts) as Promise<number>,
  termInput: (id: number, data: string) => ipcRenderer.send('terminal:input', { id, data }),
  termResize: (id: number, cols: number, rows: number) =>
    ipcRenderer.send('terminal:resize', { id, cols, rows }),
  termKill: (id: number) => ipcRenderer.send('terminal:kill', { id }),
  onTermData: (cb: (e: TermDataEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: TermDataEvent): void => cb(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTermExit: (cb: (e: TermExitEvent) => void) => {
    const listener = (_e: IpcRendererEvent, payload: TermExitEvent): void => cb(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
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
  loadProjects: () => ipcRenderer.invoke('projects:load'),
  saveProjects: (file: unknown) => ipcRenderer.invoke('projects:save', file),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder') as Promise<string | null>
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
