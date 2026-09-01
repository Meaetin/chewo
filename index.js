import { app, shell, safeStorage, ipcMain, globalShortcut, screen, BrowserWindow, Menu, dialog } from "electron";
import { readFileSync, statSync, readdirSync, existsSync, rmSync, mkdirSync, cpSync, writeFileSync, mkdtempSync, renameSync, watch, realpathSync, openSync, readSync, closeSync, writeSync, appendFileSync } from "node:fs";
import { basename, join, resolve, sep, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import chokidar from "chokidar";
import { homedir, tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import * as pty from "node-pty";
import { promisify } from "node:util";
import { readFile as readFile$1 } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DeepgramClient } from "@deepgram/sdk";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
const MAX_TASKS = 60;
const STATUSES = /* @__PURE__ */ new Set(["pending", "in_progress", "completed"]);
const str$2 = (v) => typeof v === "string" ? v.trim() : "";
const asStatus = (v) => typeof v === "string" && STATUSES.has(v) ? v : void 0;
function toTask(value) {
  if (!value || typeof value !== "object") return null;
  const t = value;
  const id = str$2(t.id);
  const subject = str$2(t.subject);
  const status = asStatus(t.status);
  if (!id || !subject || !status) return null;
  const blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy.map(str$2).filter(Boolean) : [];
  const owner2 = str$2(t.owner);
  return {
    id,
    subject,
    status,
    ...owner2 ? { owner: owner2 } : {},
    ...blockedBy.length ? { blockedBy } : {}
  };
}
function parseTaskResult(toolUseResult) {
  if (!toolUseResult || typeof toolUseResult !== "object") return null;
  const r = toolUseResult;
  if (Array.isArray(r.tasks)) {
    const tasks = [];
    for (const item of r.tasks.slice(0, MAX_TASKS)) {
      const task = toTask(item);
      if (task) tasks.push(task);
    }
    return { kind: "listed", tasks };
  }
  const created = r.task;
  if (created && typeof created === "object") {
    const t = created;
    const id2 = str$2(t.id);
    const subject = str$2(t.subject);
    if (id2 && subject) return { kind: "created", id: id2, subject };
  }
  const id = str$2(r.taskId);
  if (id) {
    const change = r.statusChange;
    const to = change && typeof change === "object" ? str$2(change.to) : "";
    if (to === "deleted") return { kind: "updated", id, deleted: true };
    return { kind: "updated", id, ...asStatus(to) ? { status: asStatus(to) } : {} };
  }
  return null;
}
function inputFields(input) {
  if (!input || typeof input !== "object") return {};
  const i = input;
  const subject = str$2(i.subject);
  const activeForm = str$2(i.activeForm);
  const owner2 = str$2(i.owner);
  const addBlockedBy = Array.isArray(i.addBlockedBy) ? i.addBlockedBy.map(str$2).filter(Boolean) : void 0;
  return {
    ...subject ? { subject } : {},
    ...activeForm ? { activeForm } : {},
    ...owner2 ? { owner: owner2 } : {},
    ...addBlockedBy?.length ? { addBlockedBy } : {}
  };
}
function applyTaskResult(tasks, result, input) {
  const extra = inputFields(input);
  switch (result.kind) {
    case "created": {
      if (tasks.some((t) => t.id === result.id)) return tasks;
      if (tasks.length >= MAX_TASKS) return tasks;
      return [
        ...tasks,
        {
          id: result.id,
          subject: result.subject,
          status: "pending",
          ...extra.activeForm ? { activeForm: extra.activeForm } : {}
        }
      ];
    }
    case "updated": {
      if (result.deleted) {
        const next22 = tasks.filter((t) => t.id !== result.id);
        return next22.length === tasks.length ? tasks : next22;
      }
      const index = tasks.findIndex((t) => t.id === result.id);
      if (index === -1) return tasks;
      const prev = tasks[index];
      const blockedBy = extra.addBlockedBy ? [.../* @__PURE__ */ new Set([...prev.blockedBy ?? [], ...extra.addBlockedBy])] : prev.blockedBy;
      const next2 = {
        ...prev,
        ...result.status ? { status: result.status } : {},
        ...extra.subject ? { subject: extra.subject } : {},
        ...extra.activeForm ? { activeForm: extra.activeForm } : {},
        ...extra.owner ? { owner: extra.owner } : {},
        ...blockedBy?.length ? { blockedBy } : {}
      };
      const out = tasks.slice();
      out[index] = next2;
      return out;
    }
    case "listed": {
      const byId = new Map(tasks.map((t) => [t.id, t]));
      return result.tasks.map((t) => {
        const prev = byId.get(t.id);
        return prev?.activeForm ? { ...t, activeForm: prev.activeForm } : t;
      });
    }
  }
}
function promptTokens(usage) {
  if (!usage || typeof usage !== "object") return void 0;
  const u = usage;
  const num2 = (v) => typeof v === "number" ? v : 0;
  const total = num2(u.input_tokens) + num2(u.cache_creation_input_tokens) + num2(u.cache_read_input_tokens);
  return total > 0 ? total : void 0;
}
const PATCH_LINE_CAP = 500;
function isHunk(value) {
  if (!value || typeof value !== "object") return false;
  const h = value;
  return typeof h.oldStart === "number" && typeof h.newStart === "number" && Array.isArray(h.lines) && h.lines.every((l) => typeof l === "string");
}
function createdHunk(content) {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body.length ? body.split("\n") : [];
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: lines.map((l) => `+${l}`)
  };
}
function capped(hunks) {
  let budget = PATCH_LINE_CAP;
  let omitted = 0;
  const out = [];
  for (const hunk of hunks) {
    if (budget <= 0) {
      omitted += hunk.lines.length;
      continue;
    }
    if (hunk.lines.length <= budget) {
      out.push(hunk);
      budget -= hunk.lines.length;
      continue;
    }
    out.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
    omitted += hunk.lines.length - budget;
    budget = 0;
  }
  return { hunks: out, omitted };
}
function parseToolPatch(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const r = raw;
  if (typeof r.filePath !== "string" || !r.filePath) return void 0;
  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch.filter(isHunk) : [];
  if (hunks.length) {
    const { hunks: kept, omitted } = capped(hunks);
    return { filePath: r.filePath, hunks: kept, ...omitted ? { omitted } : {} };
  }
  if (r.type === "create" && typeof r.content === "string") {
    const { hunks: kept, omitted } = capped([createdHunk(r.content)]);
    return { filePath: r.filePath, created: true, hunks: kept, ...omitted ? { omitted } : {} };
  }
  return void 0;
}
const MAX_RESULT_IMAGES = 4;
const MAX_IMAGE_BASE64 = 8e6;
const PAINTABLE = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
function toImage(part) {
  const source = part.source;
  if (!source || source.type !== "base64") return null;
  const mediaType = String(source.media_type ?? "");
  if (!PAINTABLE.has(mediaType)) return null;
  const data = source.data;
  if (typeof data !== "string" || !data || data.length > MAX_IMAGE_BASE64) return null;
  if (!BASE64.test(data)) return null;
  return { mediaType, data };
}
const cap = (text, limit) => limit ? text.slice(0, limit) : text;
function splitToolResult(content, opts = {}) {
  if (typeof content === "string") return { text: cap(content, opts.textCap), images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const images = [];
  const lines = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      lines.push(part.text);
      continue;
    }
    if (part.type === "image") {
      const image = toImage(part);
      if (image && images.length < MAX_RESULT_IMAGES) images.push(image);
      else lines.push(image ? "[image — not shown]" : "[image — could not be read]");
      continue;
    }
    if (part.type) lines.push(`[${part.type}]`);
  }
  return { text: cap(lines.filter(Boolean).join("\n"), opts.textCap), images };
}
const INJECTED_PATTERNS = [
  /^<[a-z][\w-]*[\s>]/i,
  // pseudo-XML blocks: <command-name>, <permissions instructions>, …
  /^# AGENTS\.md/i,
  // Codex injects AGENTS.md content under a markdown header, no tag
  /^You are\s+[`'"]?\/root[`'"]?,\s+the primary agent in a team of agents collaborating to fulfill the user's goals\./i
];
function isInjectedNoise(text) {
  const t = text.trimStart();
  return INJECTED_PATTERNS.some((re) => re.test(t));
}
function extractCommand(text) {
  const m = text.match(/<command-name>([^<]*)<\/command-name>/);
  const name = m?.[1]?.trim();
  if (!name) return null;
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}
function untitledFallback(createdAt) {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return "Untitled session";
  return `Untitled · ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
const RESULT_CAP$1 = 4e3;
const SEED_IMAGE_BUDGET = 24e6;
const KNOWN_TYPES$1 = /* @__PURE__ */ new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "file-history-snapshot",
  "mode",
  "permission-mode",
  "bridge-session",
  "last-prompt",
  "ai-title",
  "custom-title",
  "agent-name",
  "summary",
  "progress",
  "queue-operation",
  "file-history-delta",
  "pr-link"
]);
function extractFiles(input) {
  if (!input) return [];
  const files = [];
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string") files.push(v);
  }
  return files;
}
function summarizeToolInput(input) {
  if (!input) return "";
  if (typeof input.command === "string") return input.command;
  const files = extractFiles(input);
  if (files.length) return files.join(", ");
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
}
function recordToMessages(rec, results) {
  const msg = rec.message;
  if (!msg) return [];
  const role = rec.type === "assistant" ? "assistant" : "user";
  const out = [];
  const base = { timestamp: rec.timestamp, isSidechain: rec.isSidechain || void 0 };
  const pushText = (text) => {
    if (!text.trim()) return;
    if (role === "user") {
      const command = extractCommand(text);
      if (command) {
        out.push({ role, text: command, commandName: command, ...base });
        return;
      }
      if (isInjectedNoise(text)) return;
    }
    out.push({ role, text, ...base });
  };
  if (typeof msg.content === "string") {
    pushText(msg.content);
    return out;
  }
  if (!Array.isArray(msg.content)) return out;
  for (const block of msg.content) {
    if (block.type === "text" && block.text?.trim()) {
      pushText(block.text);
    } else if (block.type === "tool_use") {
      const outcome = block.id ? results.get(block.id) : void 0;
      out.push({
        role: "tool",
        toolName: block.name ?? "unknown",
        text: summarizeToolInput(block.input),
        // The arguments themselves, not just the one-line gist of them. A
        // resumed pane names a call from its own `description` and shows what a
        // subagent was briefed with; without this it can only re-read the gist,
        // which is the command with everything that explains it thrown away.
        toolInput: block.input,
        filesTouched: extractFiles(block.input),
        toolResult: outcome?.text || void 0,
        toolPatch: outcome?.patch,
        toolImages: outcome?.images,
        ...base
      });
    }
  }
  return out;
}
function collectTasks(records) {
  const inputs = /* @__PURE__ */ new Map();
  let tasks = [];
  for (const rec of records) {
    if (!Array.isArray(rec.message?.content)) continue;
    const blocks = rec.message.content;
    if (rec.type === "assistant") {
      for (const b of blocks) if (b.type === "tool_use" && b.id) inputs.set(b.id, b.input);
      continue;
    }
    if (rec.type !== "user") continue;
    const results = blocks.filter((b) => b.type === "tool_result" && b.tool_use_id);
    if (results.length !== 1) continue;
    const parsed = parseTaskResult(rec.toolUseResult);
    if (parsed) tasks = applyTaskResult(tasks, parsed, inputs.get(results[0].tool_use_id));
  }
  return tasks;
}
function collectToolResults(records) {
  const results = /* @__PURE__ */ new Map();
  let spent = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec.type !== "user" || !Array.isArray(rec.message?.content)) continue;
    const blocks = rec.message.content.filter(
      (b) => b.type === "tool_result" && b.tool_use_id
    );
    const patch = blocks.length === 1 ? parseToolPatch(rec.toolUseResult) : void 0;
    for (const block of blocks) {
      const { text, images } = splitToolResult(block.content, { textCap: RESULT_CAP$1 });
      const kept = [];
      const dropped = [];
      for (const image of images) {
        if (spent + image.data.length > SEED_IMAGE_BUDGET) dropped.push("[image — not shown]");
        else {
          spent += image.data.length;
          kept.push(image);
        }
      }
      const prose = [text, ...dropped].filter(Boolean).join("\n");
      if (prose || patch || kept.length) {
        results.set(block.tool_use_id, {
          text: prose,
          patch,
          ...kept.length ? { images: kept } : {}
        });
      }
    }
  }
  return results;
}
function parseClaudeSession(filePath2, opts = {}) {
  const raw = readFileSync(filePath2, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const stats = { linesTotal: lines.length, linesUnparseable: 0, unknownTypes: {} };
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      records.push(rec);
      if (rec.type && !KNOWN_TYPES$1.has(rec.type)) {
        stats.unknownTypes[rec.type] = (stats.unknownTypes[rec.type] ?? 0) + 1;
      }
    } catch {
      stats.linesUnparseable++;
    }
  }
  const msgRecs = records.filter(
    (r) => (r.type === "user" || r.type === "assistant") && r.message
  );
  const byUuid = /* @__PURE__ */ new Map();
  for (const r of msgRecs) if (r.uuid) byUuid.set(r.uuid, r);
  const mainRecs = msgRecs.filter((r) => !r.isSidechain);
  const leaf = mainRecs[mainRecs.length - 1];
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let cursor = leaf;
  while (cursor) {
    if (cursor.uuid) {
      if (seen.has(cursor.uuid)) break;
      seen.add(cursor.uuid);
    }
    chain.unshift(cursor);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : void 0;
  }
  const toolResults = collectToolResults(records);
  const mainMessages = mainRecs.flatMap((r) => recordToMessages(r, toolResults));
  const chainReachesStart = chain.length > 0 && chain[0] === mainRecs[0];
  const messages = chainReachesStart ? chain.flatMap((r) => recordToMessages(r, toolResults)) : [...mainMessages];
  if (opts.includeSidechains) {
    messages.push(
      ...msgRecs.filter((r) => r.isSidechain).flatMap((r) => recordToMessages(r, toolResults))
    );
  }
  const first = (pick) => {
    for (const r of records) {
      const v = pick(r);
      if (v) return v;
    }
    return void 0;
  };
  const firstUserText = messages.find((m) => m.role === "user" && !m.commandName)?.text ?? "";
  const preview = firstUserText.replace(/\s+/g, " ").trim().slice(0, 120);
  const firstAssistantText = messages.find((m) => m.role === "assistant")?.text.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
  const created = records.find((r) => r.timestamp)?.timestamp ?? "";
  const title = first((r) => r.type === "custom-title" ? r.customTitle : void 0) ?? first((r) => r.type === "ai-title" ? r.aiTitle : void 0) ?? first((r) => r.type === "summary" ? r.summary : void 0) ?? first((r) => r.type === "agent-name" ? r.agentName : void 0)?.replace(/-/g, " ") ?? first((r) => r.slug)?.replace(/-/g, " ") ?? (preview || firstAssistantText || untitledFallback(created));
  const timestamps = records.map((r) => r.timestamp).filter((t) => !!t);
  const contextTokens = (() => {
    for (let i = mainRecs.length - 1; i >= 0; i--) {
      if (mainRecs[i].type !== "assistant") continue;
      const tokens = promptTokens(mainRecs[i].message?.usage);
      if (tokens) return tokens;
    }
    return void 0;
  })();
  const settings = (() => {
    for (let i = mainRecs.length - 1; i >= 0; i--) {
      const record = mainRecs[i];
      if (record.type !== "assistant") continue;
      const model = record.message?.model;
      if (model) return { model, effort: record.effort };
    }
    return {};
  })();
  return {
    meta: {
      id: first((r) => r.sessionId) ?? basename(filePath2, ".jsonl"),
      source: "claude",
      title,
      project: first((r) => r.cwd) ?? null,
      gitBranch: first((r) => r.gitBranch),
      createdAt: timestamps[0] ?? "",
      updatedAt: timestamps[timestamps.length - 1] ?? "",
      filePath: filePath2,
      messageCount: mainMessages.filter((m) => !m.commandName).length,
      preview
    },
    contextTokens,
    ...settings,
    // Read from every record, not just the linearized chain: a plan built
    // before a compaction boundary is still the plan.
    tasks: collectTasks(mainRecs),
    messages,
    stats
  };
}
const RESULT_CAP = 4e3;
function outputValue(output) {
  if (typeof output === "string") {
    try {
      return outputValue(JSON.parse(output));
    } catch {
      return output;
    }
  }
  if (Array.isArray(output)) return output.map(outputValue).filter(Boolean).join("\n");
  if (!output || typeof output !== "object") return output == null ? "" : String(output);
  const value = output;
  if (value.output !== void 0) return outputValue(value.output);
  if (typeof value.text === "string") return value.text;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
function outputText(output) {
  return outputValue(output).slice(0, RESULT_CAP);
}
function patchText(source) {
  const literal = /\b(?:const|let|var)\s+patch\s*=\s*("(?:\\.|[^"\\])*")/.exec(source)?.[1];
  if (!literal) return source;
  try {
    return JSON.parse(literal);
  } catch {
    return source;
  }
}
const KNOWN_TYPES = /* @__PURE__ */ new Set(["session_meta", "response_item", "event_msg", "turn_context", "compacted"]);
function idFromFilename(filePath2) {
  const name = basename(filePath2, ".jsonl");
  const m = name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return m?.[0] ?? name;
}
function responseItemToMessage(payload, timestamp, results) {
  if (payload.type === "message") {
    const role = payload.role === "assistant" ? "assistant" : "user";
    const text = (payload.content ?? []).filter((c) => (c.type === "input_text" || c.type === "output_text") && c.text).map((c) => c.text).join("\n");
    if (!text.trim()) return null;
    if (role === "user") {
      const command = extractCommand(text);
      if (command) return { role, text: command, commandName: command, timestamp };
      if (isInjectedNoise(text)) return null;
    }
    return { role, text, timestamp };
  }
  if (payload.type === "function_call") {
    let text = payload.arguments ?? "";
    try {
      const args = JSON.parse(payload.arguments ?? "{}");
      if (Array.isArray(args.command)) text = args.command.join(" ");
      else if (typeof args.command === "string") text = args.command;
    } catch {
    }
    return {
      role: "tool",
      toolName: payload.name ?? "unknown",
      text: text.slice(0, 300),
      toolResult: payload.call_id ? results.get(payload.call_id) : void 0,
      timestamp
    };
  }
  if (payload.type === "local_shell_call") {
    const callId = payload.call_id ?? payload.id;
    return {
      role: "tool",
      toolName: "shell",
      text: (payload.action?.command ?? []).join(" ").slice(0, 300),
      toolResult: callId ? results.get(callId) : void 0,
      timestamp
    };
  }
  if (payload.type === "custom_tool_call") {
    const source = payload.input ?? "";
    const nested = [...source.matchAll(/\btools\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
    const operation = nested[0] ?? payload.name ?? "tool";
    const filesTouched = [
      ...patchText(source).matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)
    ].map((m) => m[1].trim()).filter(Boolean);
    if (operation === "apply_patch" || filesTouched.length) {
      const input = filesTouched.length ? { path: filesTouched[0], ...filesTouched.length > 1 ? { paths: filesTouched } : {} } : {};
      return {
        role: "tool",
        toolName: "apply_patch",
        toolDisplayName: "Edit",
        text: filesTouched[0] ?? "Patch",
        toolInput: input,
        filesTouched,
        toolResult: payload.call_id ? results.get(payload.call_id) : void 0,
        timestamp
      };
    }
    if (operation === "exec_command") {
      const rawCommand = /\bcmd\s*:\s*("(?:\\.|[^"\\])*")/.exec(source)?.[1];
      let command = "Command";
      if (rawCommand) {
        try {
          command = JSON.parse(rawCommand);
        } catch {
          command = rawCommand.slice(1, -1);
        }
      }
      return {
        role: "tool",
        toolName: "shell",
        toolDisplayName: "Shell",
        text: command,
        toolInput: { command },
        toolResult: payload.call_id ? results.get(payload.call_id) : void 0,
        timestamp
      };
    }
    const displayName = {
      view_image: "View image",
      web__run: "Web",
      update_plan: "Plan",
      read_mcp_resource: "Read resource"
    };
    return {
      role: "tool",
      toolName: operation,
      toolDisplayName: displayName[operation],
      text: source.slice(0, 300),
      toolInput: source ? { command: source.slice(0, 300) } : {},
      toolResult: payload.call_id ? results.get(payload.call_id) : void 0,
      timestamp
    };
  }
  return null;
}
function parseCodexSession(filePath2, opts = {}) {
  const raw = readFileSync(filePath2, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const stats = { linesTotal: lines.length, linesUnparseable: 0, unknownTypes: {} };
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      records.push(rec);
      if (rec.type && !KNOWN_TYPES.has(rec.type)) {
        stats.unknownTypes[rec.type] = (stats.unknownTypes[rec.type] ?? 0) + 1;
      }
    } catch {
      stats.linesUnparseable++;
    }
  }
  const sessionMeta = records.find((r) => r.type === "session_meta")?.payload;
  const id = sessionMeta?.id ?? idFromFilename(filePath2);
  const lastTurn = [...records].reverse().find((r) => r.type === "turn_context")?.payload;
  const toolResults = /* @__PURE__ */ new Map();
  for (const rec of records) {
    const p = rec.payload;
    if (rec.type !== "response_item" || !p) continue;
    if ((p.type === "function_call_output" || p.type === "local_shell_call_output" || p.type === "custom_tool_call_output") && p.call_id) {
      const text = outputText(p.output);
      if (text) toolResults.set(p.call_id, text);
    }
  }
  const messages = [];
  for (const rec of records) {
    if (rec.type !== "response_item" || !rec.payload) continue;
    const msg = responseItemToMessage(rec.payload, rec.timestamp, toolResults);
    if (msg) messages.push(msg);
  }
  const firstUserText = messages.find((m) => m.role === "user" && !m.commandName)?.text ?? "";
  const preview = firstUserText.replace(/\s+/g, " ").trim().slice(0, 120);
  const firstAssistantText = messages.find((m) => m.role === "assistant")?.text.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
  const timestamps = records.map((r) => r.timestamp).filter((t) => !!t);
  const indexTitle = opts.titleIndex?.get(id);
  const cleanIndexTitle = indexTitle && !isInjectedNoise(indexTitle) ? indexTitle : void 0;
  return {
    meta: {
      id,
      source: "codex",
      title: cleanIndexTitle ?? (preview || firstAssistantText || untitledFallback(timestamps[0] ?? "")),
      project: sessionMeta?.cwd ?? null,
      createdAt: timestamps[0] ?? "",
      updatedAt: timestamps[timestamps.length - 1] ?? "",
      filePath: filePath2,
      messageCount: messages.filter((m) => !m.commandName).length,
      preview
    },
    ...lastTurn?.model ? { model: lastTurn.model } : {},
    ...lastTurn?.effort ? { effort: lastTurn.effort } : {},
    messages,
    stats
  };
}
function parseCodexTitleIndex(indexPath2) {
  const map = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync(indexPath2, "utf8");
  } catch {
    return map;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.id && rec.thread_name) map.set(rec.id, rec.thread_name);
    } catch {
    }
  }
  return map;
}
const CLAUDE_ROOT = join(homedir(), ".claude", "projects");
const CODEX_ROOT = join(homedir(), ".codex");
function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function isDirEntry(entry, path) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function mergeUnknown(into, from) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}
function listClaudeFiles(root2) {
  const files = [];
  for (const projectDir of safeReaddir(root2)) {
    const dirPath = join(root2, projectDir.name);
    if (!isDirEntry(projectDir, dirPath)) continue;
    for (const entry of safeReaddir(dirPath)) {
      if (entry.name.endsWith(".jsonl")) files.push(join(dirPath, entry.name));
    }
  }
  return files;
}
function listCodexFiles(root2) {
  const files = [];
  const sessionsDir = join(root2, "sessions");
  const walk = (dir, depth) => {
    for (const entry of safeReaddir(dir)) {
      const p = join(dir, entry.name);
      if (isDirEntry(entry, p)) {
        if (depth < 4) walk(p, depth + 1);
      } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(p);
      }
    }
  };
  walk(sessionsDir, 0);
  return files;
}
const metaCache = /* @__PURE__ */ new Map();
let codexIndexStamp = "";
function fileStamp(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
function pruneCache(seen, roots) {
  for (const path of metaCache.keys()) {
    if (seen.has(path)) continue;
    if (roots.some((root2) => path.startsWith(root2 + sep))) metaCache.delete(path);
  }
}
function scanAll(opts = {}) {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT;
  const codexRoot = opts.codexRoot ?? CODEX_ROOT;
  const sessions = [];
  const errors = [];
  const unknownTypes = {};
  const seen = /* @__PURE__ */ new Set();
  const indexPath2 = join(codexRoot, "session_index.jsonl");
  const indexStat = fileStamp(indexPath2);
  const stamp = indexStat ? `${indexStat.mtimeMs}:${indexStat.size}` : "";
  if (stamp !== codexIndexStamp) {
    for (const [path, entry] of metaCache) {
      if (entry.meta.source === "codex") metaCache.delete(path);
    }
    codexIndexStamp = stamp;
  }
  const collect = (file, parse) => {
    seen.add(file);
    const stat = fileStamp(file);
    if (!stat) return;
    let hit = metaCache.get(file);
    if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
      try {
        const { meta, stats } = parse();
        hit = { ...stat, meta, unknownTypes: stats.unknownTypes };
        metaCache.set(file, hit);
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    mergeUnknown(unknownTypes, hit.unknownTypes);
    if (hit.meta.messageCount > 0) sessions.push(hit.meta);
  };
  for (const file of listClaudeFiles(claudeRoot)) {
    collect(file, () => parseClaudeSession(file));
  }
  let titleIndex = null;
  for (const file of listCodexFiles(codexRoot)) {
    collect(
      file,
      () => parseCodexSession(file, { titleIndex: titleIndex ??= parseCodexTitleIndex(indexPath2) })
    );
  }
  pruneCache(seen, [claudeRoot, codexRoot]);
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { sessions, errors, unknownTypes };
}
function loadSession(source, filePath2, opts = {}) {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT;
  const codexRoot = opts.codexRoot ?? CODEX_ROOT;
  const resolved = resolve(filePath2);
  const allowed = source === "claude" ? claudeRoot : codexRoot;
  if (!resolved.startsWith(allowed + "/")) {
    throw new Error(`Refusing to read outside session roots: ${resolved}`);
  }
  return source === "claude" ? parseClaudeSession(resolved) : parseCodexSession(resolved, {
    titleIndex: parseCodexTitleIndex(join(codexRoot, "session_index.jsonl"))
  });
}
const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, "");
function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let key = null;
  let folded = false;
  let listMode = false;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      folded = v === ">-" || v === ">" || v === "|" || v === "|-";
      listMode = v === "";
      out[key] = folded ? "" : unquote(v);
      continue;
    }
    const item = line.match(/^\s*-\s+(.*\S)\s*$/);
    if (key && listMode && item) {
      const value = unquote(item[1]);
      out[key] = out[key] ? `${out[key]}, ${value}` : value;
      continue;
    }
    if (key && folded && /^\s+\S/.test(line)) {
      out[key] = (out[key] ? out[key] + " " : "") + line.trim();
    }
  }
  return out;
}
function splitList(raw) {
  if (!raw) return [];
  return raw.replace(/^\[/, "").replace(/\]$/, "").split(",").map(unquote).filter(Boolean);
}
function parseCodexMcp(toml) {
  const refs = /* @__PURE__ */ new Map();
  let current = null;
  let inEnvOf = null;
  for (const line of toml.split("\n")) {
    const envSection = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\.env\]/);
    if (envSection) {
      inEnvOf = refs.get(envSection[1] ?? envSection[2]) ?? null;
      current = null;
      continue;
    }
    const section = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\].]+))\]/);
    if (section) {
      const name = section[1] ?? section[2];
      current = { name, tool: "codex", scope: "user", command: "", raw: {} };
      refs.set(name, current);
      inEnvOf = null;
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      inEnvOf = null;
      continue;
    }
    if (inEnvOf) {
      const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (key) (inEnvOf.envKeys ??= []).push(key[1]);
      continue;
    }
    if (!current) continue;
    const cmd = line.match(/^command\s*=\s*"(.*)"/);
    if (cmd) {
      current.raw.command = cmd[1];
      current.command = cmd[1] + (current.command ? " " + current.command : "");
    }
    const args = line.match(/^args\s*=\s*\[(.*)\]/);
    if (args) {
      const list = args[1].replace(/"/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      current.raw.args = list;
      const joined = list.join(" ");
      current.command = current.command ? `${current.command} ${joined}` : joined;
    }
    const url = line.match(/^url\s*=\s*"(.*)"/);
    if (url) {
      current.raw.url = url[1];
      if (!current.command) current.command = url[1];
    }
  }
  return [...refs.values()];
}
function claudeMcpCommand(entry) {
  if (entry.url) return entry.url;
  return [entry.command, ...entry.args ?? []].filter(Boolean).join(" ");
}
function claudeMcpRef(name, entry, scope) {
  return {
    name,
    tool: "claude",
    scope,
    command: claudeMcpCommand(entry),
    raw: { command: entry.command, args: entry.args, url: entry.url },
    envKeys: entry.env ? Object.keys(entry.env) : void 0
    // names only, never values
  };
}
const USER = { kind: "user" };
const PROJECT = { kind: "project" };
function fileRef(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return void 0;
    const content = readFileSync(path, "utf8");
    const firstLine = content.split("\n").find((l) => l.trim()) ?? "";
    return { path, bytes: stat.size, firstLine: firstLine.trim().slice(0, 120) };
  } catch {
    return void 0;
  }
}
function readSkillsDir(dir, tools, origin) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    try {
      const md = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(md);
      skills.push({
        name: fm.name || entry,
        description: fm.description ?? "",
        dir: skillDir,
        bytes: md.length,
        tools,
        origin
      });
    } catch {
    }
  }
  return skills;
}
function readAgentsDir(dir, origin) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const agents = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const fm = parseFrontmatter(readFileSync(path, "utf8"));
      agents.push({
        name: fm.name || entry.replace(/\.md$/, ""),
        description: fm.description ?? "",
        path,
        origin,
        // Absent stays absent: `model` omitted means "inherit", which is not
        // the same claim as any particular model id.
        model: fm.model || void 0,
        effort: fm.effort || void 0,
        color: fm.color || void 0,
        tools: splitList(fm.tools),
        disallowedTools: splitList(fm.disallowedTools),
        skills: splitList(fm.skills)
      });
    } catch {
    }
  }
  return agents;
}
function readPluginCapabilities(plugins) {
  const skills = [];
  const agents = [];
  for (const p of plugins) {
    const origin = {
      kind: "plugin",
      plugin: p.plugin,
      marketplace: p.marketplace,
      version: p.version,
      enabled: p.enabled
    };
    skills.push(...readSkillsDir(join(p.installPath, "skills"), ["claude"], origin));
    agents.push(...readAgentsDir(join(p.installPath, "agents"), origin));
  }
  return { skills, agents };
}
function readClaudeProjectMcp(projectPath) {
  try {
    const cfg = JSON.parse(readFileSync(join(projectPath, ".mcp.json"), "utf8"));
    return Object.entries(cfg.mcpServers ?? {}).map(
      ([name, entry]) => claudeMcpRef(name, entry, "project")
    );
  } catch {
    return [];
  }
}
function parseClaudeHooks(settingsPath) {
  let hooksObj;
  try {
    const cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
    hooksObj = cfg.hooks ?? {};
  } catch {
    return [];
  }
  const refs = [];
  for (const [event, entries] of Object.entries(hooksObj)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command !== "string") continue;
        refs.push({ event, matcher: entry.matcher || void 0, command: hook.command, settingsPath });
      }
    }
  }
  return refs;
}
function readClaudeProjectHooks(projectPath) {
  return [
    ...parseClaudeHooks(join(projectPath, ".claude", "settings.json")),
    ...parseClaudeHooks(join(projectPath, ".claude", "settings.local.json"))
  ];
}
function scanCapabilities(projects, roots = {}) {
  const claudeHome = roots.claudeHome ?? join(homedir(), ".claude");
  const codexHome = roots.codexHome ?? join(homedir(), ".codex");
  const claudeConfig = roots.claudeConfig ?? join(homedir(), ".claude.json");
  const plugin = readPluginCapabilities(roots.plugins ?? []);
  const inventories = [];
  let claudeUserMcp = [];
  try {
    const cfg = JSON.parse(readFileSync(claudeConfig, "utf8"));
    claudeUserMcp = Object.entries(cfg.mcpServers ?? {}).map(
      ([name, entry]) => claudeMcpRef(name, entry, "user")
    );
  } catch {
  }
  inventories.push({
    scope: { kind: "global", tool: "claude" },
    memory: { claudeMd: fileRef(join(claudeHome, "CLAUDE.md")) },
    skills: [...readSkillsDir(join(claudeHome, "skills"), ["claude"], USER), ...plugin.skills],
    agents: [...readAgentsDir(join(claudeHome, "agents"), USER), ...plugin.agents],
    mcp: claudeUserMcp,
    hooks: parseClaudeHooks(join(claudeHome, "settings.json"))
  });
  let codexMcp = [];
  try {
    codexMcp = parseCodexMcp(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
  }
  inventories.push({
    scope: { kind: "global", tool: "codex" },
    memory: { agentsMd: fileRef(join(codexHome, "AGENTS.md")) },
    skills: readSkillsDir(join(codexHome, "skills"), ["codex"], USER),
    agents: [],
    mcp: codexMcp,
    hooks: []
    // Codex hook definitions are plugin-managed, not user config
  });
  for (const p of projects) {
    inventories.push({
      scope: { kind: "project", projectId: p.id, name: p.name, path: p.path },
      memory: {
        claudeMd: fileRef(join(p.path, "CLAUDE.md")),
        agentsMd: fileRef(join(p.path, "AGENTS.md"))
      },
      skills: [
        ...readSkillsDir(join(p.path, ".claude", "skills"), ["claude"], PROJECT),
        ...readSkillsDir(join(p.path, ".codex", "skills"), ["codex"], PROJECT),
        ...readSkillsDir(join(p.path, ".agents", "skills"), ["codex"], PROJECT)
      ],
      agents: readAgentsDir(join(p.path, ".claude", "agents"), PROJECT),
      mcp: readClaudeProjectMcp(p.path),
      hooks: readClaudeProjectHooks(p.path)
    });
  }
  return inventories;
}
const CLAUDE_PERMISSION_MODES = [
  "manual",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions"
];
const CODEX_APPROVAL_POLICIES = ["untrusted", "on-request", "never"];
const EMPTY_PROJECTS_FILE = {
  projects: [],
  selectedProjectId: null,
  hiddenSessionIds: [],
  homeTerminals: [],
  homeSettings: {},
  worktrees: []
};
const normalize = (p) => p.endsWith("/") ? p.slice(0, -1) : p;
function matchSessionToPane(panes, session, clockSlopMs = 1e4) {
  const createdMs = Date.parse(session.createdAt);
  if (Number.isNaN(createdMs)) return null;
  const candidates = panes.filter((p) => p.source === session.source).filter((p) => normalize(p.cwd) === normalize(session.project ?? "")).filter((p) => createdMs >= p.spawnedAtMs - clockSlopMs).sort((a, b) => a.spawnedAtMs - b.spawnedAtMs);
  return candidates[0] ?? null;
}
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
let next = 1;
function nextPaneId() {
  return next++;
}
function safeSend(win, channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
  }
}
const terminals = /* @__PURE__ */ new Map();
function buildPtyEnv(base) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === void 0) continue;
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_")) continue;
    env[key] = value;
  }
  return env;
}
function permissionFlag(source, opts) {
  if (source === "claude") {
    const mode = opts.permissionMode;
    return mode && CLAUDE_PERMISSION_MODES.includes(mode) ? ` --permission-mode ${mode}` : "";
  }
  const policy = opts.approvalPolicy;
  return policy && CODEX_APPROVAL_POLICIES.includes(policy) ? ` --ask-for-approval ${policy}` : "";
}
function modelFlags(source, opts) {
  const model = opts.model?.trim();
  const effort = opts.effort?.trim();
  if (source === "claude") {
    return (model ? ` --model ${shellQuote(model)}` : "") + (effort ? ` --effort ${shellQuote(effort)}` : "");
  }
  return (model ? ` -m ${shellQuote(model)}` : "") + (effort ? ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}` : "");
}
function promptFlags(opts) {
  if (opts.source === "shell") return "";
  const prompt = opts.initialPrompt?.trim();
  const head = prompt ? ` ${shellQuote(prompt)}` : "";
  const tail = opts.source === "claude" ? (opts.extraDirs ?? []).map((dir) => ` --add-dir ${shellQuote(dir)}`).join("") : (opts.attachImages ?? []).map((file) => ` -i ${shellQuote(file)}`).join("");
  return `${head}${tail}`;
}
function buildCommand(opts) {
  if (opts.source === "shell") {
    const run2 = opts.runCommand?.trim();
    return run2 ? `${run2}; exec /bin/zsh -il` : null;
  }
  const flags = permissionFlag(opts.source, opts) + modelFlags(opts.source, opts);
  const tail = promptFlags(opts);
  const agent = opts.source === "claude" ? opts.sessionId ? `claude --resume ${opts.sessionId}${flags}${tail}` : `claude${flags}${tail}` : opts.sessionId ? `codex resume ${opts.sessionId}${flags}` : `codex${flags}${tail}`;
  return opts.setupCommand ? `(${opts.setupCommand}) && ${agent}` : agent;
}
function createTerminal(win, opts) {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
  const command = buildCommand(opts);
  const proc2 = pty.spawn("/bin/zsh", command ? ["-il", "-c", command] : ["-il"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env: buildPtyEnv(process.env)
  });
  const id = nextPaneId();
  terminals.set(id, {
    proc: proc2,
    source: opts.source,
    cwd,
    spawnedAtMs: Date.now(),
    sessionId: opts.sessionId
  });
  proc2.onData((data) => {
    safeSend(win, "terminal:data", { id, data });
  });
  proc2.onExit(({ exitCode }) => {
    terminals.delete(id);
    safeSend(win, "terminal:exit", { id, exitCode });
  });
  return id;
}
function writeTerminal(id, data) {
  terminals.get(id)?.proc.write(data);
}
function resizeTerminal(id, cols, rows) {
  if (cols > 0 && rows > 0) terminals.get(id)?.proc.resize(cols, rows);
}
function killTerminal(id) {
  terminals.get(id)?.proc.kill();
  terminals.delete(id);
}
function disposeAllTerminals() {
  for (const rec of terminals.values()) rec.proc.kill();
  terminals.clear();
}
const lastNudgeMs = /* @__PURE__ */ new Map();
const NUDGE_DEBOUNCE_MS = 5e3;
function nudgeAgentPane(source) {
  let best;
  for (const rec of terminals.values()) {
    if (rec.source === source && (!best || rec.spawnedAtMs > best.spawnedAtMs)) best = rec;
  }
  if (!best) return false;
  const last = lastNudgeMs.get(source) ?? 0;
  if (Date.now() - last > NUDGE_DEBOUNCE_MS) {
    best.proc.write("check your inbox");
    lastNudgeMs.set(source, Date.now());
  }
  return true;
}
function getUnboundPanes() {
  const out = [];
  for (const [termId, rec] of terminals) {
    if (!rec.sessionId && rec.source !== "shell") {
      out.push({ termId, source: rec.source, cwd: rec.cwd, spawnedAtMs: rec.spawnedAtMs });
    }
  }
  return out;
}
function bindPaneSession(termId, sessionId) {
  const rec = terminals.get(termId);
  if (rec) rec.sessionId = sessionId;
}
let claudePath;
function shellLookup$1(bin) {
  return new Promise((resolve2) => {
    execFile(
      "/bin/zsh",
      ["-ilc", `command -v ${bin}`],
      { timeout: 15e3, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve2(err ? null : String(stdout).trim() || null)
    );
  });
}
function splitPluginId(id) {
  const at = id.lastIndexOf("@");
  if (at <= 0 || at === id.length - 1) return null;
  return { plugin: id.slice(0, at), marketplace: id.slice(at + 1) };
}
function parsePluginList(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = typeof row.id === "string" ? row.id : "";
    const installPath = typeof row.installPath === "string" ? row.installPath : "";
    const parts = splitPluginId(id);
    if (!parts || !installPath) continue;
    out.push({
      id,
      plugin: parts.plugin,
      marketplace: parts.marketplace,
      version: typeof row.version === "string" ? row.version : "",
      installPath,
      enabled: row.enabled !== false
    });
  }
  return out;
}
const CACHE_MS$1 = 3e4;
let cached$3 = null;
let inFlight$3 = null;
async function listInstalledPlugins() {
  if (cached$3 && Date.now() - cached$3.at < CACHE_MS$1) return cached$3.plugins;
  if (inFlight$3) return inFlight$3;
  inFlight$3 = readInstalledPlugins().then((plugins) => {
    cached$3 = { at: Date.now(), plugins };
    return plugins;
  }).finally(() => {
    inFlight$3 = null;
  });
  return inFlight$3;
}
async function readInstalledPlugins() {
  if (claudePath === void 0) claudePath = await shellLookup$1("claude");
  if (!claudePath) return [];
  return new Promise((resolve2) => {
    execFile(
      claudePath,
      ["plugin", "list", "--json"],
      { timeout: 2e4, maxBuffer: 16 * 1024 * 1024, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve2(err ? [] : parsePluginList(String(stdout)))
    );
  });
}
function claudeChatArgs(opts) {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--verbose"
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  for (const dir of opts.extraDirs ?? []) args.push("--add-dir", dir);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.forwardSubagentText) args.push("--forward-subagent-text");
  return args;
}
const num = (v) => typeof v === "number" ? v : 0;
function contextWindowFor(raw, model) {
  if (!raw || typeof raw !== "object") return void 0;
  const entries = Object.entries(raw);
  if (entries.length === 0) return void 0;
  const own = entries.find(([id, u]) => id === model || u.canonicalModel === model)?.[1];
  const read = (u) => num(u.inputTokens) + num(u.cacheReadInputTokens);
  const busiest = entries.map(([, u]) => u).sort((a, b) => read(b) - read(a))[0];
  const window = (own ?? busiest).contextWindow;
  return typeof window === "number" && window > 0 ? window : void 0;
}
function createClaudeNormalizer() {
  let messageSeq = 0;
  let currentMessageId = "";
  let openBlocks = /* @__PURE__ */ new Map();
  const streamedMessages = /* @__PURE__ */ new Set();
  let sessionModel = "";
  const blockId = (index) => `${currentMessageId || `m${messageSeq}`}:${index}`;
  return function normalize2(raw) {
    if (!raw || typeof raw !== "object") return [];
    const ev = raw;
    const out = [];
    if (ev.type === "system" && ev.subtype === "init") {
      const info = {
        sessionId: String(ev.session_id ?? ""),
        model: String(ev.model ?? ""),
        cwd: String(ev.cwd ?? ""),
        slashCommands: Array.isArray(ev.slash_commands) ? ev.slash_commands : [],
        mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []
      };
      sessionModel = info.model;
      return [{ type: "session", info }];
    }
    if (ev.type === "rate_limit_event") {
      const info = ev.rate_limit_info;
      if (!info?.rateLimitType) return [];
      const usage = {
        limitType: info.rateLimitType,
        limitStatus: info.status,
        limitResetsAt: typeof info.resetsAt === "number" ? info.resetsAt : void 0
      };
      return [{ type: "usage", usage }];
    }
    if (ev.type === "stream_event") {
      const inner = ev.event;
      if (!inner) return [];
      if (inner.type === "message_start") {
        const message = inner.message;
        messageSeq++;
        currentMessageId = message?.id ?? `m${messageSeq}`;
        openBlocks = /* @__PURE__ */ new Map();
        streamedMessages.add(currentMessageId);
        return [];
      }
      if (inner.type === "content_block_start") {
        const index = Number(inner.index ?? 0);
        const block = inner.content_block;
        if (block?.type === "thinking" || block?.type === "text") {
          const id = blockId(index);
          openBlocks.set(index, { blockId: id, kind: block.type });
          return [{ type: "block_start", blockId: id, block: block.type }];
        }
        if (block?.type === "tool_use" && block.id) {
          openBlocks.set(index, { blockId: block.id, kind: "tool" });
          const call = {
            toolUseId: block.id,
            name: block.name ?? "tool",
            input: {},
            status: "running",
            parentToolUseId: ev.parent_tool_use_id ?? null
          };
          return [{ type: "tool_start", call }];
        }
        return [];
      }
      if (inner.type === "content_block_delta") {
        const open = openBlocks.get(Number(inner.index ?? 0));
        if (!open || open.kind === "tool") return [];
        const delta = inner.delta;
        const text = delta?.type === "text_delta" ? delta.text : delta?.type === "thinking_delta" ? delta.thinking : void 0;
        return text ? [{ type: "block_delta", blockId: open.blockId, text }] : [];
      }
      if (inner.type === "content_block_stop") {
        const open = openBlocks.get(Number(inner.index ?? 0));
        if (!open || open.kind === "tool") return [];
        return [{ type: "block_end", blockId: open.blockId }];
      }
      return [];
    }
    if (ev.type === "assistant") {
      const message = ev.message;
      const id = message?.id ?? "";
      const alreadyStreamed = streamedMessages.has(id);
      if (!ev.parent_tool_use_id) {
        const contextTokens = promptTokens(message?.usage);
        if (contextTokens) out.push({ type: "usage", usage: { contextTokens } });
      }
      let index = 0;
      for (const block of message?.content ?? []) {
        if (block.type === "tool_use" && block.id) {
          if (alreadyStreamed) out.push({ type: "tool_input", toolUseId: block.id, input: block.input ?? {} });
          else
            out.push({
              type: "tool_start",
              call: {
                toolUseId: block.id,
                name: block.name ?? "tool",
                input: block.input ?? {},
                status: "running",
                parentToolUseId: ev.parent_tool_use_id ?? null
              }
            });
        } else if (!alreadyStreamed && (block.type === "text" || block.type === "thinking")) {
          const text = block.type === "text" ? block.text : block.thinking;
          if (text) {
            const synthetic = `${id || `m${++messageSeq}`}:${index}`;
            out.push({ type: "block_start", blockId: synthetic, block: block.type });
            out.push({ type: "block_delta", blockId: synthetic, text });
            out.push({ type: "block_end", blockId: synthetic });
          }
        }
        index++;
      }
      return out;
    }
    if (ev.type === "user") {
      const message = ev.message;
      if (!Array.isArray(message?.content)) return [];
      const blocks = message.content.filter((b) => b.type === "tool_result" && b.tool_use_id);
      const single = blocks.length === 1;
      const patch = single ? parseToolPatch(ev.tool_use_result) : void 0;
      const task = single ? parseTaskResult(ev.tool_use_result) : null;
      for (const block of blocks) {
        const { text, images } = splitToolResult(block.content);
        out.push({
          type: "tool_result",
          toolUseId: block.tool_use_id,
          result: text,
          isError: Boolean(block.is_error),
          patch,
          ...images.length ? { images } : {},
          ...task ? { task } : {}
        });
      }
      return out;
    }
    if (ev.type === "control_request") {
      const request = ev.request;
      if (request?.subtype !== "can_use_tool" || !request.tool_use_id) return [];
      return [
        {
          type: "tool_approval",
          toolUseId: request.tool_use_id,
          requestId: String(ev.request_id ?? ""),
          description: request.description,
          input: request.input,
          // Not a permission question at all: the tool answers *on* this card
          requiresUserInteraction: request.requires_user_interaction === true,
          suggestions: request.permission_suggestions ?? []
        }
      ];
    }
    if (ev.type === "result") {
      const contextWindow = contextWindowFor(ev.modelUsage, sessionModel);
      if (contextWindow) out.push({ type: "usage", usage: { contextWindow } });
      out.push(
        {
          type: "turn_end",
          stats: {
            costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : void 0,
            durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : void 0,
            isError: Boolean(ev.is_error)
          }
        }
      );
      return out;
    }
    if (ev.type === "error" && typeof ev.message === "string")
      return [{ type: "notice", tone: "error", text: ev.message }];
    return [];
  };
}
const INIT_REQUEST_ID$1 = "chewo-init";
const TIMEOUT_MS$4 = 2e4;
const CACHE_MS = 6e4;
const cached$2 = /* @__PURE__ */ new Map();
const inFlight$2 = /* @__PURE__ */ new Map();
async function claudeSlashCommands(cwd) {
  const dir = cwd && existsSync(cwd) ? cwd : homedir();
  const hit = cached$2.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.commands;
  const running = inFlight$2.get(dir);
  if (running) return running;
  const read = probe(dir).then((commands) => {
    if (commands.length) cached$2.set(dir, { at: Date.now(), commands });
    return commands;
  }).finally(() => {
    inFlight$2.delete(dir);
  });
  inFlight$2.set(dir, read);
  return read;
}
function probe(cwd) {
  return new Promise((resolve2) => {
    let settled = false;
    const finish = (commands) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer2);
      proc2.kill();
      resolve2(commands);
    };
    const proc2 = spawn("/bin/zsh", ["-ilc", 'claude "$@"', "chewo", ...claudeChatArgs({})], {
      cwd,
      env: buildPtyEnv(process.env)
    });
    const timer2 = setTimeout(() => finish([]), TIMEOUT_MS$4);
    proc2.on("error", () => finish([]));
    proc2.on("exit", () => finish([]));
    let buffer = "";
    proc2.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let raw;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const reply = raw;
        if (reply.type !== "control_response" || reply.response?.request_id !== INIT_REQUEST_ID$1)
          continue;
        finish(
          (reply.response.response?.commands ?? []).map((c) => c.name).filter((n) => Boolean(n))
        );
        return;
      }
    });
    proc2.stdin.on("error", () => finish([]));
    proc2.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: INIT_REQUEST_ID$1,
        request: { subtype: "initialize", hooks: {} }
      }) + "\n"
    );
  });
}
const MODELLED = [
  "name",
  "description",
  "model",
  "effort",
  "color",
  "tools",
  "disallowedTools",
  "skills"
];
function splitAgentFile(md) {
  const m = md.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { entries: [], body: md };
  const entries = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):(?:\s|$)/);
    if (kv) entries.push({ key: kv[1], lines: [line] });
    else if (entries.length > 0) entries[entries.length - 1].lines.push(line);
  }
  return { entries, body: md.slice(m[0].length) };
}
function scalar(value) {
  const s = value.replace(/\s*\r?\n\s*/g, " ").trim();
  if (s === "") return "''";
  if (/^[A-Za-z0-9][A-Za-z0-9 _./()+-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
const flowList = (items) => `[${items.map(scalar).join(", ")}]`;
function sanitizeAgentName(raw) {
  return raw.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}
function agentFileName(name) {
  const slug = sanitizeAgentName(name);
  if (!slug) throw new Error(`agent name has no usable characters: ${name}`);
  return `${slug}.md`;
}
function emit$2(key, draft) {
  switch (key) {
    case "name":
      return `name: ${scalar(sanitizeAgentName(draft.name))}`;
    case "description":
      return `description: ${scalar(draft.description)}`;
    case "model":
      return draft.model ? `model: ${scalar(draft.model)}` : null;
    case "effort":
      return draft.effort ? `effort: ${scalar(draft.effort)}` : null;
    case "color":
      return draft.color ? `color: ${scalar(draft.color)}` : null;
    case "tools":
      return draft.tools.length > 0 ? `tools: ${flowList(draft.tools)}` : null;
    case "disallowedTools":
      return draft.disallowedTools.length > 0 ? `disallowedTools: ${flowList(draft.disallowedTools)}` : null;
    case "skills": {
      const preloaded = draft.skills.filter((s) => s.preload).map((s) => s.name);
      return preloaded.length > 0 ? `skills: ${flowList(preloaded)}` : null;
    }
  }
}
function serializeAgent(draft, existing) {
  const parsed = existing ? splitAgentFile(existing) : { entries: [] };
  const modelled = new Set(MODELLED);
  const written = /* @__PURE__ */ new Set();
  const lines = [];
  for (const entry of parsed.entries) {
    if (!modelled.has(entry.key)) {
      lines.push(...entry.lines);
      continue;
    }
    if (written.has(entry.key)) continue;
    written.add(entry.key);
    const next2 = emit$2(entry.key, draft);
    if (next2 !== null) lines.push(next2);
  }
  for (const key of MODELLED) {
    if (written.has(key)) continue;
    const next2 = emit$2(key, draft);
    if (next2 !== null) lines.push(next2);
  }
  const body = draft.systemPrompt.replace(/\s+$/, "");
  return `---
${lines.join("\n")}
---

${body}
`;
}
function skillsDirFor(dest, roots) {
  if (dest.kind === "global") {
    return dest.tool === "claude" ? join(roots.claudeHome ?? join(homedir(), ".claude"), "skills") : join(roots.codexHome ?? join(homedir(), ".codex"), "skills");
  }
  if (!dest.path) throw new Error("project destination requires a path");
  return join(dest.path, dest.tool === "claude" ? ".claude" : ".codex", "skills");
}
function agentsDirFor(dest, roots) {
  if (dest.kind === "global") return join(roots.claudeHome ?? join(homedir(), ".claude"), "agents");
  if (!dest.path) throw new Error("project destination requires a path");
  return join(dest.path, ".claude", "agents");
}
function safeName(name) {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error(`unsafe capability name: ${name}`);
  }
  return name;
}
function copySkill(sourceDir, destinations, overwrite = false, roots = {}) {
  if (!statSync(sourceDir).isDirectory() || !existsSync(join(sourceDir, "SKILL.md"))) {
    throw new Error(`not a skill directory (no SKILL.md): ${sourceDir}`);
  }
  readFileSync(join(sourceDir, "SKILL.md"), "utf8");
  const name = safeName(basename(sourceDir));
  return destinations.map((dest) => {
    let targetDir = "";
    try {
      targetDir = join(skillsDirFor(dest, roots), name);
      if (existsSync(targetDir)) {
        if (!overwrite) return { dest, status: "exists", path: targetDir };
        rmSync(targetDir, { recursive: true, force: true });
      }
      mkdirSync(join(targetDir, ".."), { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      return { dest, status: "copied", path: targetDir };
    } catch (err) {
      return {
        dest,
        status: "error",
        path: targetDir,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}
const MEMORY_FILES = /* @__PURE__ */ new Set(["CLAUDE.md", "AGENTS.md"]);
function memoryPathFor(dest, filename, roots) {
  if (dest.kind === "project") {
    if (!dest.path) throw new Error("project destination requires a path");
    return join(dest.path, filename);
  }
  return filename === "CLAUDE.md" ? join(roots.claudeHome ?? join(homedir(), ".claude"), "CLAUDE.md") : join(roots.codexHome ?? join(homedir(), ".codex"), "AGENTS.md");
}
function copyMemoryFile(sourcePath, destinations, roots = {}) {
  const filename = basename(sourcePath);
  if (!MEMORY_FILES.has(filename)) {
    throw new Error(`not an instruction file (CLAUDE.md/AGENTS.md): ${sourcePath}`);
  }
  const content = readFileSync(sourcePath, "utf8");
  return destinations.map((dest) => {
    let targetPath = "";
    try {
      targetPath = memoryPathFor(dest, filename, roots);
      if (existsSync(targetPath)) return { dest, status: "exists", path: targetPath };
      mkdirSync(join(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, content);
      return { dest, status: "copied", path: targetPath };
    } catch (err) {
      return {
        dest,
        status: "error",
        path: targetPath,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}
function readAgentFile(path) {
  if (!path.endsWith(".md") || basename(dirname(path)) !== "agents") {
    throw new Error(`refusing to read non-agent file: ${path}`);
  }
  return readFileSync(path, "utf8");
}
function readMemoryFile(path) {
  if (!MEMORY_FILES.has(basename(path))) {
    throw new Error(`refusing to read non-instruction file: ${path}`);
  }
  return readFileSync(path, "utf8");
}
function hookSettingsPathFor(dest, roots) {
  if (dest.kind === "global") {
    return join(roots.claudeHome ?? join(homedir(), ".claude"), "settings.json");
  }
  if (!dest.path) throw new Error("project destination requires a path");
  return join(dest.path, ".claude", "settings.json");
}
function copyHook(ref, destinations, roots = {}) {
  if (!ref.event || typeof ref.command !== "string" || !ref.command.trim()) {
    throw new Error("invalid hook: needs event and command");
  }
  return destinations.map((dest) => {
    let settingsPath = "";
    try {
      settingsPath = hookSettingsPathFor(dest, roots);
      let cfg = {};
      if (existsSync(settingsPath)) {
        cfg = JSON.parse(readFileSync(settingsPath, "utf8"));
      }
      cfg.hooks ??= {};
      const entries = cfg.hooks[ref.event] ??= [];
      const alreadyThere = entries.some(
        (e) => (e.matcher || void 0) === ref.matcher && (e.hooks ?? []).some((h) => h.command === ref.command)
      );
      if (alreadyThere) return { dest, status: "exists", path: settingsPath };
      const slot = entries.find((e) => (e.matcher || void 0) === ref.matcher);
      const hook = { type: "command", command: ref.command };
      if (slot) (slot.hooks ??= []).push(hook);
      else entries.push(ref.matcher ? { matcher: ref.matcher, hooks: [hook] } : { hooks: [hook] });
      mkdirSync(join(settingsPath, ".."), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + "\n");
      return { dest, status: "copied", path: settingsPath };
    } catch (err) {
      return {
        dest,
        status: "error",
        path: settingsPath,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}
function copyAgent(sourcePath, destinations, overwrite = false, roots = {}) {
  if (!sourcePath.endsWith(".md") || !statSync(sourcePath).isFile()) {
    throw new Error(`not an agent definition file: ${sourcePath}`);
  }
  const name = safeName(basename(sourcePath));
  return destinations.map((dest) => {
    let targetPath = "";
    try {
      targetPath = join(agentsDirFor(dest, roots), name);
      if (existsSync(targetPath) && !overwrite) {
        return { dest, status: "exists", path: targetPath };
      }
      mkdirSync(join(targetPath, ".."), { recursive: true });
      cpSync(sourcePath, targetPath);
      return { dest, status: "copied", path: targetPath };
    } catch (err) {
      return {
        dest,
        status: "error",
        path: targetPath,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  });
}
function writeAgent(draft, dest, overwrite = false, roots = {}) {
  let targetPath = "";
  try {
    targetPath = join(agentsDirFor(dest, roots), agentFileName(draft.name));
    const present = existsSync(targetPath);
    if (present && !overwrite) return { dest, status: "exists", path: targetPath };
    const existing = present ? readFileSync(targetPath, "utf8") : void 0;
    mkdirSync(join(targetPath, ".."), { recursive: true });
    writeFileSync(targetPath, serializeAgent(draft, existing));
    return { dest, status: "copied", path: targetPath };
  } catch (err) {
    return {
      dest,
      status: "error",
      path: targetPath,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const AGENTS = {
  claude: {
    id: "claude",
    label: "Claude",
    bin: "claude",
    defaultModel: "sonnet",
    models: [
      { id: "opus", label: "Opus", efforts: EFFORT_LEVELS, detail: "Most capable" },
      { id: "sonnet", label: "Sonnet", efforts: EFFORT_LEVELS, detail: "Balanced — default" },
      { id: "haiku", label: "Haiku", efforts: EFFORT_LEVELS, detail: "Fastest, cheapest" },
      { id: "fable", label: "Fable", efforts: EFFORT_LEVELS, detail: "Deepest reasoning" }
    ],
    discoverable: false,
    streamsDeltas: true,
    strictSchema: false
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: "codex",
    // Empty = pass no -m, so the user's ~/.codex/config.toml default wins.
    defaultModel: "",
    // Only a fallback — the real list comes from `codex debug models`.
    models: [],
    discoverable: true,
    streamsDeltas: false,
    strictSchema: true
  }
};
function agentDef(id) {
  return AGENTS[id] ?? AGENTS.claude;
}
const DEFAULT_AGENTS = {
  notesStructure: { agent: "claude" },
  notesChat: { agent: "claude" },
  todoVoice: { agent: "claude" },
  gitText: { agent: "claude" },
  agentBuild: { agent: "claude" }
};
const AGENT_TASKS = [
  {
    id: "notesStructure",
    group: "Notes",
    label: "Structure dictation",
    hint: "Turns a raw transcript into markdown appended to the lesson."
  },
  {
    id: "notesChat",
    group: "Notes",
    label: "Ask your notes",
    hint: "Read-only Q&A over the notes folder, scoped by the picker."
  },
  {
    id: "todoVoice",
    group: "To-dos",
    label: "Voice commands",
    hint: "Interprets a dictated utterance into board commands."
  },
  {
    id: "gitText",
    group: "Git",
    label: "Branch & commit text",
    hint: "Names isolated branches from your first message, and writes commit messages and PR text for Ship. Never blocks: a failure falls back to a plain generated string."
  },
  {
    id: "agentBuild",
    group: "Capabilities",
    label: "Agent builder",
    hint: "Turns a description into a subagent draft — system prompt, model, tool policy and suggested skills — for you to review before anything is written."
  }
];
function normalizeAgents(partial) {
  const out = {};
  for (const { id } of AGENT_TASKS) {
    const choice2 = partial?.[id];
    const known = Boolean(choice2 && choice2.agent in AGENTS);
    const agent = known ? choice2.agent : DEFAULT_AGENTS[id].agent;
    const next2 = { agent };
    if (known) {
      const model = choice2.model;
      const effort = choice2.effort;
      if (typeof model === "string" && model) next2.model = model;
      if (typeof effort === "string" && effort) next2.effort = effort;
    }
    out[id] = next2;
  }
  return out;
}
function modelFlag(choice2) {
  const def = agentDef(choice2.agent);
  const model = choice2.model || def.defaultModel;
  if (!model) return "";
  return def.id === "claude" ? ` --model ${shellQuote(model)}` : ` -m ${shellQuote(model)}`;
}
function effortFlag(choice2) {
  const def = agentDef(choice2.agent);
  if (!choice2.effort) return "";
  return def.id === "claude" ? ` --effort ${shellQuote(choice2.effort)}` : ` -c model_reasoning_effort=${shellQuote(choice2.effort)}`;
}
function toStrictSchema(node) {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node))
    out[key] = toStrictSchema(value);
  const props = out.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}
function lastCodexMessage(stdout) {
  let text = null;
  let failure = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev.type === "error" && typeof ev.message === "string") failure = ev.message;
    if (ev.type === "turn.failed") {
      const err = ev.error;
      failure = err?.message ?? failure ?? "turn failed";
    }
    const item = ev.item;
    if (ev.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string")
      text = item.text;
  }
  if (text !== null) return text;
  if (failure) throw new Error(failure.slice(0, 300));
  return null;
}
function run$1(cmd, opts) {
  return new Promise((resolvePromise, reject) => {
    const proc2 = spawn("/bin/zsh", ["-ilc", cmd], {
      cwd: opts.cwd,
      env: buildPtyEnv(process.env)
    });
    const timeout = setTimeout(() => {
      proc2.kill();
      reject(new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1e3)}s`));
    }, opts.timeoutMs);
    let stdout = "";
    let stderr = "";
    proc2.stdout.on("data", (d) => stdout += d.toString());
    proc2.stderr.on("data", (d) => stderr += d.toString());
    proc2.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`${opts.label} failed to start: ${err.message}`));
    });
    proc2.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`${agentDef(opts.choice.agent).bin} exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolvePromise(stdout);
    });
    proc2.stdin.write(opts.prompt);
    proc2.stdin.end();
  });
}
async function runAgentText(opts) {
  const def = agentDef(opts.choice.agent);
  if (def.id === "claude") {
    const cmd2 = `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-format json`;
    const stdout2 = await run$1(cmd2, opts);
    let parsed;
    try {
      parsed = JSON.parse(stdout2);
    } catch {
      throw new Error(`Unparseable claude -p output for ${opts.label}`);
    }
    if (parsed.is_error || typeof parsed.result !== "string")
      throw new Error(`claude reported an error result for ${opts.label}`);
    return parsed.result.trim();
  }
  const cmd = `codex exec --json -s read-only --skip-git-repo-check${modelFlag(opts.choice)}${effortFlag(opts.choice)} -`;
  const stdout = await run$1(cmd, opts);
  const text = lastCodexMessage(stdout);
  if (text === null) throw new Error(`codex returned no message for ${opts.label}`);
  return text.trim();
}
async function runAgentJson(opts) {
  const def = agentDef(opts.choice.agent);
  if (def.id === "claude") {
    const cmd = `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-format json --json-schema '${opts.schema}'`;
    const stdout = await run$1(cmd, opts);
    let envelope;
    try {
      envelope = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`${opts.label} returned unparseable output.`);
    }
    if (envelope.structured_output !== void 0) return envelope.structured_output;
    if (typeof envelope.result === "string") {
      try {
        return JSON.parse(envelope.result);
      } catch {
        throw new Error(`${opts.label} gave no structured output: ${envelope.result.slice(0, 120)}`);
      }
    }
    throw new Error(`${opts.label} gave no structured output.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "chewo-schema-"));
  const schemaPath = join(dir, "schema.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(toStrictSchema(JSON.parse(opts.schema))));
    const cmd = `codex exec --json -s read-only --skip-git-repo-check${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-schema '${schemaPath}' -`;
    const stdout = await run$1(cmd, opts);
    const text = lastCodexMessage(stdout);
    if (text === null) throw new Error(`${opts.label} returned no output.`);
    try {
      return JSON.parse(text.trim());
    } catch {
      throw new Error(`${opts.label} returned unparseable output: ${text.slice(0, 120)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function chatCommand(opts) {
  const def = agentDef(opts.choice.agent);
  if (def.id === "claude") {
    const resume = opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : "";
    return `claude -p${modelFlag(opts.choice)}${effortFlag(opts.choice)} --output-format stream-json --verbose --allowedTools "Read,Grep,Glob" --disallowedTools "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch"` + resume;
  }
  const flags = `--json -s read-only --skip-git-repo-check${modelFlag(opts.choice)}${effortFlag(opts.choice)}`;
  return opts.resumeSessionId ? `codex exec resume ${opts.resumeSessionId} ${flags} -` : `codex exec ${flags} -`;
}
const CODEX_TOOL_ITEMS = {
  command_execution: "shell",
  file_change: "edit",
  mcp_tool_call: "tool",
  web_search: "search",
  todo_list: "plan"
};
function normalizeChatEvent(agent, ev) {
  if (agentDef(agent).id === "claude") {
    const type2 = ev.type;
    if (type2 === "system" && ev.subtype === "init" && typeof ev.session_id === "string")
      return [{ type: "chat_session", sessionId: ev.session_id }];
    if (type2 === "assistant") {
      const message = ev.message;
      const out = [];
      for (const block of message?.content ?? []) {
        if (block.type === "text" && block.text)
          out.push({ type: "chat_text", text: block.text, delta: true });
        else if (block.type === "tool_use")
          out.push({ type: "chat_tool", name: block.name ?? "tool" });
      }
      return out;
    }
    if (type2 === "result") return [{ type: "chat_result", isError: Boolean(ev.is_error) }];
    return [];
  }
  const type = ev.type;
  if (type === "thread.started" && typeof ev.thread_id === "string")
    return [{ type: "chat_session", sessionId: ev.thread_id }];
  if (type === "item.started" || type === "item.completed") {
    const item = ev.item;
    if (!item?.type) return [];
    if (item.type === "agent_message")
      return type === "item.completed" && typeof item.text === "string" ? (
        // codex emits whole messages, not deltas — each one is its own bubble
        [{ type: "chat_text", text: item.text, delta: false }]
      ) : [];
    const tool = CODEX_TOOL_ITEMS[item.type];
    return tool && type === "item.started" ? [{ type: "chat_tool", name: tool }] : [];
  }
  if (type === "turn.completed") return [{ type: "chat_result", isError: false }];
  if (type === "turn.failed") {
    const err = ev.error;
    return [{ type: "chat_error", message: err?.message ?? "The answer failed — try again." }];
  }
  if (type === "error" && typeof ev.message === "string")
    return [{ type: "chat_error", message: ev.message }];
  return [];
}
const DEFAULT_LAYOUT = {
  sidebarWidth: 300,
  toolsWidth: 620,
  explorerWidth: 240,
  explorerCollapsed: false
};
const DEFAULT_APPEARANCE = {
  base: "#141414",
  // --c-surface-0 (graphite)
  accent: "#3bbf8b",
  // --c-accent (emerald)
  accentSecondary: "#948ada",
  // --c-project (periwinkle)
  accentTertiary: "#ef7fc8",
  // --c-live (magenta)
  terminal: {
    black: "#232323",
    red: "#e2574b",
    green: "#79b36a",
    yellow: "#dfa94e",
    blue: "#6ba4f8",
    magenta: "#c98aa9",
    cyan: "#34c9d6",
    white: "#d8d5d0",
    brightBlack: "#5a5a5a",
    brightRed: "#ec6c61",
    brightGreen: "#93c586",
    brightYellow: "#e9bc6e",
    brightBlue: "#8fbdfa",
    brightMagenta: "#d6a2bc",
    brightCyan: "#5fd7e2",
    brightWhite: "#f4f1ec"
  },
  editor: {
    keyword: "#b3a7ff",
    string: "#5fd39b",
    number: "#e6b667",
    function: "#83b9ff",
    type: "#5ad4e0",
    tag: "#e79070",
    attribute: "#e6b667",
    property: "#d7d3ea",
    punctuation: "#adaaa6",
    comment: "#8a8781",
    regexp: "#ef8a80",
    link: "#83b9ff",
    invalid: "#e2574b"
  },
  notes: {
    heading: "#4ccf9b",
    // emerald — lesson headings pop, on-theme
    link: "#3bbf8b",
    // accent
    code: "#5fd39b",
    // soft green — inline code reads as code
    quote: "#807d78"
    // text-tertiary — quiet blockquotes
  }
};
const DEFAULT_STT_MODEL = "nova-3-general";
const MODEL_ALIASES = {
  "nova-3": "nova-3-general",
  "nova-2": "nova-2-general",
  nova: "nova-general",
  enhanced: "enhanced-general"
};
const DEFAULT_STT_SETTINGS = {
  language: "en"
};
function normalizeStt(partial) {
  const raw = partial?.model;
  const model = typeof raw === "string" ? MODEL_ALIASES[raw] ?? raw : raw;
  const usable = typeof model === "string" && model !== "" && !model.startsWith("openai_whisper-");
  const language = partial?.language;
  const keyterms = partial?.keyterms;
  return {
    model: usable ? model : DEFAULT_STT_MODEL,
    language: typeof language === "string" && language ? language : DEFAULT_STT_SETTINGS.language,
    ...Array.isArray(keyterms) && keyterms.length ? { keyterms: keyterms.filter((t) => typeof t === "string" && t.trim() !== "") } : {}
  };
}
const filePath$2 = () => join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    const parsed = JSON.parse(readFileSync(filePath$2(), "utf8"));
    const a = parsed.appearance;
    return {
      appearance: {
        ...DEFAULT_APPEARANCE,
        ...a,
        terminal: { ...DEFAULT_APPEARANCE.terminal, ...a?.terminal },
        editor: { ...DEFAULT_APPEARANCE.editor, ...a?.editor },
        notes: { ...DEFAULT_APPEARANCE.notes, ...a?.notes }
      },
      agents: normalizeAgents(parsed.agents),
      stt: normalizeStt(parsed.stt),
      layout: { ...DEFAULT_LAYOUT, ...parsed.layout }
    };
  } catch {
    return {
      appearance: DEFAULT_APPEARANCE,
      agents: normalizeAgents(void 0),
      stt: normalizeStt(void 0),
      layout: DEFAULT_LAYOUT
    };
  }
}
function agentFor(task) {
  return loadSettings().agents[task];
}
function saveSettings(file) {
  const path = filePath$2();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2));
}
const MAX_SKILLS = 200;
const MAX_SKILL_DESC = 240;
const str$1 = (v) => typeof v === "string" ? v.trim() : "";
const strings = (v) => Array.isArray(v) ? v.map(str$1).filter(Boolean) : [];
function readDraft(raw, offered) {
  const known = new Map(offered.map((s) => [s.name, s]));
  const name = sanitizeAgentName(str$1(raw.name));
  if (!name) throw new Error("The agent builder returned no usable name.");
  const description = str$1(raw.description);
  const systemPrompt = str$1(raw.systemPrompt);
  if (!description || !systemPrompt)
    throw new Error("The agent builder returned an incomplete draft.");
  const chosen = Array.isArray(raw.skills) ? raw.skills : [];
  const seen = /* @__PURE__ */ new Set();
  const skills = [];
  for (const entry of chosen) {
    if (!entry || typeof entry !== "object") continue;
    const skillName = str$1(entry.name);
    const found = known.get(skillName);
    if (!found || seen.has(skillName)) continue;
    seen.add(skillName);
    skills.push({
      name: skillName,
      reason: str$1(entry.reason),
      preload: false,
      installed: found.installed,
      pluginId: found.pluginId
    });
  }
  return {
    name,
    description,
    systemPrompt,
    model: str$1(raw.model) || void 0,
    effort: str$1(raw.effort) || void 0,
    tools: strings(raw.tools),
    disallowedTools: strings(raw.disallowedTools),
    skills
  };
}
const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Lowercase hyphenated handle, 2-4 words, e.g. api-reviewer"
    },
    description: {
      type: "string",
      description: "One or two sentences naming the situations this agent should be delegated to. This is the router."
    },
    systemPrompt: {
      type: "string",
      description: "The complete system prompt in markdown. The agent inherits nothing, so this must stand alone."
    },
    model: {
      type: ["string", "null"],
      description: "One of opus, sonnet, haiku, fable, or null to inherit the session model"
    },
    effort: {
      type: ["string", "null"],
      description: "One of low, medium, high, xhigh, max, or null to inherit"
    },
    tools: {
      type: "array",
      items: { type: "string" },
      description: "Allowlist. Leave empty to grant every tool; only narrow it for a real reason."
    },
    disallowedTools: {
      type: "array",
      items: { type: "string" },
      description: "Denylist, e.g. Write and Edit for a review-only agent"
    },
    skills: {
      type: "array",
      description: "Skills chosen from the offered list only",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          reason: { type: "string", description: "Why this agent needs it, one sentence" }
        },
        required: ["name", "reason"]
      }
    }
  },
  required: ["name", "description", "systemPrompt"]
});
function buildPrompt$1(req) {
  const skills = req.skills.slice(0, MAX_SKILLS).map((s) => `- ${s.name} (${s.origin}): ${s.description.slice(0, MAX_SKILL_DESC)}`);
  const existing = req.existing.map((a) => `- ${a.name}: ${a.description}`);
  return [
    "Design a Claude Code subagent from this request. Reply only through the schema.",
    "",
    "--- the request ---",
    req.request,
    "",
    "Rules that matter:",
    "",
    "1. `description` is the router — it is the only thing the main agent reads",
    "   when deciding whether to hand work over. Name the situations, not the",
    '   qualities. "Use when reviewing a diff for security issues before merge"',
    '   routes; "an expert security reviewer" does not.',
    "2. `systemPrompt` is the ENTIRE system prompt. A subagent inherits nothing,",
    "   so state the role, how to approach the work, what to check, and what to",
    "   return. Write it for the agent, not about it. No preamble, no headings",
    "   that just restate the name.",
    "3. Model: opus for architecture, security and review; sonnet for docs,",
    "   tests and debugging; haiku for fast mechanical work; fable for long",
    "   autonomous runs. Return null to inherit the session model, which is the",
    "   right answer for general domain work.",
    "4. Tools: leave the allowlist empty unless narrowing it serves the role.",
    "   Prefer a denylist for a read-only agent (disallow Write, Edit).",
    "5. Skills: choose ONLY from the list below, by exact name, and only ones",
    "   this agent would genuinely reach for. Give a one-sentence reason for",
    "   each. Choosing none is a fine answer.",
    "",
    skills.length ? "--- skills available ---" : "--- no skills available ---",
    ...skills,
    "",
    existing.length ? "--- agents that already exist (do not duplicate their routing) ---" : "",
    ...existing
  ].filter((line) => line !== "").join("\n");
}
const TIMEOUT_MS$3 = 18e4;
const CAPABLE = { agent: "claude", model: "opus", effort: "high" };
function neutralCwd$1() {
  const dir = join(homedir(), ".chewo", "agent-builder");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function choice() {
  const chosen = agentFor("agentBuild");
  if (chosen.agent !== CAPABLE.agent) return chosen;
  return {
    ...chosen,
    model: chosen.model || CAPABLE.model,
    effort: chosen.effort || CAPABLE.effort
  };
}
async function draftAgent(req) {
  try {
    const raw = await runAgentJson({
      choice: choice(),
      cwd: neutralCwd$1(),
      prompt: buildPrompt$1(req),
      schema: SCHEMA,
      timeoutMs: TIMEOUT_MS$3,
      label: "Agent builder"
    });
    if (!raw || typeof raw !== "object") return { ok: false, error: "The builder returned no draft." };
    return { ok: true, draft: readDraft(raw, req.skills) };
  } catch (err) {
    return { ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}
const execFileAsync$2 = promisify(execFile);
function buildClaudeMcpAddCommand(ref) {
  if (ref.raw?.url) {
    return `claude mcp add --scope user --transport http ${shellQuote(ref.name)} ${shellQuote(ref.raw.url)}`;
  }
  if (ref.raw?.command) {
    const args = (ref.raw.args ?? []).map(shellQuote).join(" ");
    return `claude mcp add --scope user ${shellQuote(ref.name)} -- ${shellQuote(ref.raw.command)}${args ? " " + args : ""}`;
  }
  return null;
}
function buildCodexMcpAddCommand(ref) {
  if (!ref.raw?.command) return null;
  const args = (ref.raw.args ?? []).map(shellQuote).join(" ");
  return `codex mcp add ${shellQuote(ref.name)} -- ${shellQuote(ref.raw.command)}${args ? " " + args : ""}`;
}
function addMcpToProjectFile(ref, projectPath, overwrite = false) {
  const filePath2 = join(projectPath, ".mcp.json");
  let cfg = {};
  if (existsSync(filePath2)) {
    cfg = JSON.parse(readFileSync(filePath2, "utf8"));
  }
  cfg.mcpServers ??= {};
  if (cfg.mcpServers[ref.name] && !overwrite) return "exists";
  const entry = {};
  if (ref.raw?.url) {
    entry.type = "http";
    entry.url = ref.raw.url;
  } else {
    entry.command = ref.raw?.command;
    if (ref.raw?.args?.length) entry.args = ref.raw.args;
  }
  cfg.mcpServers[ref.name] = entry;
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(filePath2, JSON.stringify(cfg, null, 2) + "\n");
  return "copied";
}
async function runLoginShell$1(command) {
  try {
    const { stdout, stderr } = await execFileAsync$2("/bin/zsh", ["-ilc", command], {
      timeout: 2e4
    });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const e = err;
    return { ok: false, output: (e.stderr || e.stdout || e.message || "command failed").trim() };
  }
}
async function copyMcp(ref, destinations, overwrite = false) {
  const results = [];
  for (const dest of destinations) {
    const envNote = ref.envKeys?.length ? ` (env not copied — set manually: ${ref.envKeys.join(", ")})` : "";
    try {
      if (dest.tool === "codex" && dest.kind === "project") {
        results.push({
          dest,
          status: "error",
          path: "",
          error: "Codex has no per-project MCP servers — use Personal · Codex instead"
        });
      } else if (dest.tool === "claude" && dest.kind === "project") {
        const status = addMcpToProjectFile(ref, dest.path, overwrite);
        results.push({ dest, status, path: join(dest.path, ".mcp.json"), error: status === "copied" && envNote ? envNote : void 0 });
      } else {
        const command = dest.tool === "claude" ? buildClaudeMcpAddCommand(ref) : buildCodexMcpAddCommand(ref);
        if (!command) {
          results.push({
            dest,
            status: "error",
            path: "",
            error: dest.tool === "codex" ? "URL-based servers cannot be added to Codex" : "entry has no command or url"
          });
          continue;
        }
        const run2 = await runLoginShell$1(command);
        results.push(
          run2.ok ? { dest, status: "copied", path: command, error: envNote || void 0 } : { dest, status: "error", path: command, error: run2.output.slice(0, 300) }
        );
      }
    } catch (err) {
      results.push({
        dest,
        status: "error",
        path: "",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return results;
}
const MCP_ROOT = join(homedir(), ".chewo", "mcp");
const LEGACY_MCP_ROOT = join(homedir(), ".context-bridge");
function adoptLegacyMcpRoot() {
  if (existsSync(MCP_ROOT) || !existsSync(LEGACY_MCP_ROOT)) return;
  try {
    mkdirSync(dirname(MCP_ROOT), { recursive: true });
    renameSync(LEGACY_MCP_ROOT, MCP_ROOT);
  } catch {
  }
}
const MCP_SERVER_NAME = "chewo";
const LEGACY_MCP_SERVER_NAME = "context-bridge";
const execFileAsync$1 = promisify(execFile);
const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
function mcpScriptPath() {
  const path = app.isPackaged ? join(process.resourcesPath, "bin", "chewo-mcp.cjs") : join(app.getAppPath(), "packages", "chewo-mcp", "dist", "index.cjs");
  return existsSync(path) ? path : null;
}
function entryFromClaudeConfig(raw, name) {
  try {
    const cfg = JSON.parse(raw);
    const entry = cfg.mcpServers?.[name];
    if (!entry?.command) return null;
    return { command: entry.command, args: entry.args ?? [] };
  } catch {
    return null;
  }
}
function entryFromCodexToml(toml, name) {
  const raw = parseCodexMcp(toml).find((r) => r.name === name)?.raw;
  if (!raw?.command) return null;
  return { command: raw.command, args: raw.args ?? [] };
}
function readEntry(agent, name) {
  try {
    const config = agent === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG;
    const raw = readFileSync(config, "utf8");
    return agent === "claude" ? entryFromClaudeConfig(raw, name) : entryFromCodexToml(raw, name);
  } catch {
    return null;
  }
}
function isCurrent(entry, execPath, scriptPath) {
  return scriptPath !== null && entry.command === execPath && entry.args.includes(scriptPath);
}
const describe = (entry) => [entry.command, ...entry.args].join(" ");
async function runLoginShell(command) {
  try {
    const { stdout, stderr } = await execFileAsync$1("/bin/zsh", ["-ilc", command], {
      timeout: 2e4
    });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (err) {
    const e = err;
    return { ok: false, output: (e.stderr || e.stdout || e.message || "command failed").trim() };
  }
}
async function installedClis() {
  const run2 = await runLoginShell("command -v claude; command -v codex");
  const found = /* @__PURE__ */ new Set();
  if (!run2.ok) return found;
  for (const line of run2.output.split("\n")) {
    const bin = line.trim().split("/").pop();
    if (bin === "claude") found.add("claude");
    if (bin === "codex") found.add("codex");
  }
  return found;
}
function buildAddCommand(agent, execPath, scriptPath) {
  const target = `${shellQuote(execPath)} ${shellQuote(scriptPath)} --agent ${agent}`;
  return agent === "claude" ? `claude mcp add ${MCP_SERVER_NAME} --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${target}` : `codex mcp add ${MCP_SERVER_NAME} --env ELECTRON_RUN_AS_NODE=1 -- ${target}`;
}
function buildRemoveCommand(agent, name) {
  return agent === "claude" ? `claude mcp remove --scope user ${shellQuote(name)}` : `codex mcp remove ${shellQuote(name)}`;
}
async function mcpServerStatus() {
  const scriptPath = mcpScriptPath();
  const clis = await installedClis();
  const agents = ["claude", "codex"].map((agent) => {
    if (!clis.has(agent)) return { agent, state: "cli-missing" };
    const entry = readEntry(agent, MCP_SERVER_NAME);
    if (entry) {
      return {
        agent,
        state: isCurrent(entry, process.execPath, scriptPath) ? "connected" : "stale",
        registered: describe(entry)
      };
    }
    const legacy = readEntry(agent, LEGACY_MCP_SERVER_NAME);
    if (legacy) return { agent, state: "legacy", registered: describe(legacy) };
    return { agent, state: "disconnected" };
  });
  return { scriptPath, agents };
}
async function connectMcpServer(agent) {
  const scriptPath = mcpScriptPath();
  if (!scriptPath) {
    return {
      agent,
      ok: false,
      error: app.isPackaged ? "The MCP server bundle is missing from this build of Chewo." : "No dev build of the MCP server — run `npm run build:mcp`."
    };
  }
  if (readEntry(agent, LEGACY_MCP_SERVER_NAME)) {
    await runLoginShell(buildRemoveCommand(agent, LEGACY_MCP_SERVER_NAME));
  }
  const run2 = await runLoginShell(buildAddCommand(agent, process.execPath, scriptPath));
  return run2.ok ? { agent, ok: true } : { agent, ok: false, error: run2.output.slice(0, 300) };
}
async function disconnectMcpServer(agent) {
  const name = readEntry(agent, MCP_SERVER_NAME) ? MCP_SERVER_NAME : LEGACY_MCP_SERVER_NAME;
  const run2 = await runLoginShell(buildRemoveCommand(agent, name));
  return run2.ok ? { agent, ok: true } : { agent, ok: false, error: run2.output.slice(0, 300) };
}
async function reconcileMcpServer() {
  if (!app.isPackaged || !mcpScriptPath()) return;
  const scriptPath = mcpScriptPath();
  for (const agent of ["claude", "codex"]) {
    const entry = readEntry(agent, MCP_SERVER_NAME);
    if (entry && isCurrent(entry, process.execPath, scriptPath)) continue;
    if (!entry && !readEntry(agent, LEGACY_MCP_SERVER_NAME)) continue;
    await connectMcpServer(agent);
  }
}
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
function parseNote(content) {
  const match = FRONTMATTER.exec(content);
  if (!match) return { body: content };
  const parsed = { body: content.slice(match[0].length).replace(/^\n/, "") };
  for (const line of match[1].split("\n")) {
    const sep2 = line.indexOf(":");
    if (sep2 === -1) continue;
    const key = line.slice(0, sep2).trim();
    const value = line.slice(sep2 + 1).trim();
    if (key === "title") parsed.title = value;
    else if (key === "date") parsed.date = value;
    else if (key === "source" && (value === "dictation" || value === "paste" || value === "typed"))
      parsed.source = value;
    else if (key === "status" && (value === "raw" || value === "structured"))
      parsed.status = value;
  }
  return parsed;
}
function serializeNote(meta, body) {
  return `---
title: ${meta.title}
date: ${meta.date}
source: ${meta.source}
status: ${meta.status}
---

${body}`;
}
function kebabCase(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";
}
function isValidFolderName(name) {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 80 && !trimmed.startsWith(".") && !/[/\\:]/.test(trimmed);
}
const legacyRoot = join(homedir(), "ChewoNotes");
const DEFAULT_NOTES_ROOT = existsSync(legacyRoot) ? legacyRoot : join(homedir(), "Documents", "Chewo Notes");
let notesRoot = DEFAULT_NOTES_ROOT;
function setNotesRoot(root2) {
  notesRoot = root2;
}
function getNotesRoot() {
  mkdirSync(notesRoot, { recursive: true });
  return notesRoot;
}
function assertInsideRoot(path) {
  const resolved = resolve(path);
  const root2 = resolve(getNotesRoot());
  if (resolved !== root2 && !resolved.startsWith(root2 + sep))
    throw new Error(`path outside notes root: ${path}`);
  return resolved;
}
const fail$1 = (error) => ({ ok: false, error });
function readNoteMeta(path, fileName) {
  let title = "";
  let date = "";
  let source = "typed";
  let status = "structured";
  try {
    const parsed = parseNote(readFileSync(path, "utf8"));
    title = parsed.title ?? "";
    date = parsed.date ?? "";
    source = parsed.source ?? "typed";
    status = parsed.status ?? "structured";
  } catch {
  }
  if (!title)
    title = fileName.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "") || fileName;
  if (!date) {
    try {
      date = statSync(path).mtime.toISOString();
    } catch {
      date = "";
    }
  }
  return { path, fileName, title, date, source, status };
}
const visibleDirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort((a, b) => a.localeCompare(b));
function scanNotes() {
  const root2 = getNotesRoot();
  const subjects = visibleDirs(root2).map((subjectName) => {
    const subjectPath = join(root2, subjectName);
    const topics = visibleDirs(subjectPath).map((topicName) => {
      const topicPath = join(subjectPath, topicName);
      const notes = readdirSync(topicPath, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.endsWith(".raw.md")).map((e) => readNoteMeta(join(topicPath, e.name), e.name)).sort((a, b) => b.date.localeCompare(a.date));
      return { name: topicName, path: topicPath, notes };
    });
    return { name: subjectName, path: subjectPath, topics };
  });
  return { root: root2, subjects };
}
function createSubject(name) {
  if (!isValidFolderName(name)) return fail$1("Invalid name");
  try {
    mkdirSync(join(getNotesRoot(), name.trim()));
    return { ok: true };
  } catch (err) {
    return fail$1(
      err.code === "EEXIST" ? "A subject with that name already exists" : String(err)
    );
  }
}
function createTopic(subject, name) {
  if (!isValidFolderName(name)) return fail$1("Invalid name");
  try {
    const subjectPath = assertInsideRoot(join(getNotesRoot(), subject));
    mkdirSync(join(subjectPath, name.trim()));
    return { ok: true };
  } catch (err) {
    return fail$1(
      err.code === "EEXIST" ? "A topic with that name already exists" : String(err)
    );
  }
}
function createNote(args) {
  const title = args.title.trim() || "Untitled";
  try {
    const topicPath = assertInsideRoot(join(getNotesRoot(), args.subject, args.topic));
    const now = /* @__PURE__ */ new Date();
    const datePrefix = now.toISOString().slice(0, 10);
    const base = `${datePrefix}-${kebabCase(title)}`;
    let fileName = `${base}.md`;
    for (let n = 2; ; n++) {
      try {
        statSync(join(topicPath, fileName));
        fileName = `${base}-${n}.md`;
      } catch {
        break;
      }
    }
    const path = join(topicPath, fileName);
    writeFileSync(
      path,
      serializeNote(
        {
          title,
          date: now.toISOString(),
          source: args.source ?? "typed",
          status: "structured"
        },
        args.body ?? ""
      )
    );
    return { ok: true, path };
  } catch (err) {
    return fail$1(String(err));
  }
}
function readNote(path) {
  return readFileSync(assertInsideRoot(path), "utf8");
}
function writeNote(path, content) {
  writeFileSync(assertInsideRoot(path), content);
}
function renameNoteItem(path, newName) {
  if (!isValidFolderName(newName)) return fail$1("Invalid name");
  try {
    const resolved = assertInsideRoot(path);
    if (resolved === resolve(getNotesRoot())) return fail$1("Cannot rename the notes root");
    const name = newName.trim();
    const target = join(dirname(resolved), name);
    if (target === resolved) return { ok: true, path: resolved };
    if (target.toLowerCase() !== resolved.toLowerCase() && existsSync(target))
      return fail$1(`"${name}" already exists`);
    renameSync(resolved, target);
    return { ok: true, path: target };
  } catch (err) {
    return fail$1(String(err));
  }
}
async function deleteNoteItem(path) {
  try {
    const resolved = assertInsideRoot(path);
    if (resolved === resolve(getNotesRoot())) return fail$1("Cannot delete the notes root");
    await shell.trashItem(resolved);
    return { ok: true };
  } catch (err) {
    return fail$1(String(err));
  }
}
const filePath$1 = () => join(app.getPath("userData"), "projects.json");
function loadProjects() {
  try {
    const parsed = JSON.parse(readFileSync(filePath$1(), "utf8"));
    if (!Array.isArray(parsed.projects)) return EMPTY_PROJECTS_FILE;
    return {
      ...parsed,
      hiddenSessionIds: parsed.hiddenSessionIds ?? [],
      homeTerminals: parsed.homeTerminals ?? [],
      homeSettings: parsed.homeSettings ?? {},
      worktrees: parsed.worktrees ?? []
    };
  } catch {
    return EMPTY_PROJECTS_FILE;
  }
}
function saveProjects(file) {
  const path = filePath$1();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2));
}
const DEFAULT_LOCAL_FILES = [
  ".env",
  ".env.*",
  "!*.example",
  "!*.sample",
  "!*.template"
];
function parseLocalFilePatterns(text) {
  const lines = (text ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  return lines.length > 0 ? lines : DEFAULT_LOCAL_FILES;
}
const compiled = /* @__PURE__ */ new Map();
function globToRegExp(glob) {
  const cached2 = compiled.get(glob);
  if (cached2) return cached2;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const re = new RegExp(`^${source}$`);
  compiled.set(glob, re);
  return re;
}
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
function matchesLocalFile(relPath, patterns) {
  const path = relPath.replace(/\/$/, "");
  let wanted = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const glob = (negated ? raw.slice(1) : raw).replace(/\/$/, "");
    if (!glob) continue;
    const subject = glob.includes("/") ? path : baseName(path);
    if (globToRegExp(glob).test(subject)) wanted = !negated;
  }
  return wanted;
}
function runGit(cwd, args, timeoutMs = 6e4) {
  return new Promise((resolve2) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      // Never let a credential prompt hang a non-interactive call
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        resolve2({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}
const gitErrorOf = (r) => r.stderr.trim() || r.stdout.trim() || "git failed";
const NOT_A_REPO = /not a git repository/i;
const NO_COMMITS = /does not have any commits yet|bad default revision|unknown revision/i;
const ORDINARY_PATH_FIELD = 8;
const RENAME_PATH_FIELD = 9;
const UNMERGED_PATH_FIELD = 10;
function statusLetter(record, xy) {
  if (record === "u") return "U";
  const x = xy[0];
  const y = xy[1];
  if (record === "2") return x === "C" || y === "C" ? "C" : "R";
  const c = y !== "." ? y : x;
  return c === "M" || c === "A" || c === "D" || c === "T" ? c : "M";
}
function parseNumstat(stdout) {
  const map = /* @__PURE__ */ new Map();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    const path = m[3] !== "" ? m[3] : tokens[i += 2];
    if (path === void 0) break;
    map.set(path, {
      additions: m[1] === "-" ? null : Number(m[1]),
      deletions: m[2] === "-" ? null : Number(m[2])
    });
  }
  return map;
}
async function defaultRemoteRef(cwd) {
  const symref = await runGit(cwd, ["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symref.ok && symref.stdout.trim()) return symref.stdout.trim();
  for (const name of ["main", "master", "trunk", "develop"]) {
    const exists = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
    if (exists.ok) return `origin/${name}`;
  }
  return null;
}
async function staleCheckout(root2) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return null;
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return null;
  const branch = head.stdout.trim();
  if (!branch || branch === "HEAD") return null;
  const remoteRef = await defaultRemoteRef(cwd);
  if (!remoteRef) return null;
  const target = remoteRef.slice(remoteRef.indexOf("/") + 1);
  if (branch === target) return null;
  const dirty = await runGit(cwd, ["status", "--porcelain", "-uno"]);
  if (!dirty.ok || dirty.stdout.trim()) return null;
  const unsent = await runGit(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  if (!unsent.ok || unsent.stdout.trim() !== "0") return null;
  const merged = await runGit(cwd, ["merge-base", "--is-ancestor", branch, remoteRef]);
  return { branch, target, reason: merged.ok ? "merged" : "pushed" };
}
async function gitStatus(root2) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  const res = await runGit(real, ["status", "--porcelain=v2", "--branch", "-z"]);
  if (!res.ok) {
    if (NOT_A_REPO.test(res.stderr)) return { ok: true, isRepo: false };
    return { ok: false, error: gitErrorOf(res) };
  }
  let branch = "";
  let detached = false;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let baseRef = null;
  let headOid = null;
  const files = [];
  const tokens = res.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "") continue;
    if (t.startsWith("# branch.oid ")) {
      const oid = t.slice("# branch.oid ".length);
      headOid = oid === "(initial)" ? null : oid;
    } else if (t.startsWith("# branch.head ")) {
      const head = t.slice("# branch.head ".length);
      detached = head === "(detached)";
      branch = head;
    } else if (t.startsWith("# branch.upstream ")) {
      upstream = t.slice("# branch.upstream ".length);
    } else if (t.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(t);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (t.startsWith("1 ")) {
      const parts = t.split(" ");
      const xy = parts[1];
      files.push({
        path: parts.slice(ORDINARY_PATH_FIELD).join(" "),
        status: statusLetter("1", xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
        additions: null,
        deletions: null
      });
    } else if (t.startsWith("2 ")) {
      const parts = t.split(" ");
      const xy = parts[1];
      files.push({
        path: parts.slice(RENAME_PATH_FIELD).join(" "),
        origPath: tokens[++i],
        status: statusLetter("2", xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
        additions: null,
        deletions: null
      });
    } else if (t.startsWith("u ")) {
      const parts = t.split(" ");
      files.push({
        path: parts.slice(UNMERGED_PATH_FIELD).join(" "),
        status: "U",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null
      });
    } else if (t.startsWith("? ")) {
      const path = t.slice(2);
      files.push({
        path,
        status: "?",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
        ...path.endsWith("/") && { isDir: true }
      });
    }
  }
  if (detached && headOid) branch = headOid.slice(0, 7);
  if (!upstream && headOid && !detached) {
    const base = await defaultRemoteRef(real);
    if (base) {
      const count = await runGit(real, ["rev-list", "--count", `HEAD..${base}`]);
      if (count.ok) behind = Number(count.stdout.trim()) || 0;
      baseRef = base;
    }
  }
  if (headOid && files.some((f) => f.status !== "?")) {
    const numstat = await runGit(real, ["diff", "--numstat", "-z", "--find-renames", "HEAD"]);
    if (numstat.ok) {
      const stats = parseNumstat(numstat.stdout);
      for (const f of files) {
        const s = stats.get(f.path);
        if (s) {
          f.additions = s.additions;
          f.deletions = s.deletions;
        }
      }
    }
  }
  return { ok: true, isRepo: true, branch, detached, upstream, ahead, behind, baseRef, headOid, files };
}
const MAX_UNTRACKED_LISTED = 500;
const safePathspec = (p) => p !== "" && !p.startsWith("/") && !p.startsWith(":") && !p.startsWith("-") && !p.split("/").includes("..");
async function gitUntrackedFiles(root2, dir) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  if (!safePathspec(dir)) return { ok: false, error: "invalid path" };
  const res = await runGit(real, ["ls-files", "--others", "--exclude-standard", "-z", "--", dir]);
  if (!res.ok) return { ok: false, error: gitErrorOf(res) };
  const paths = res.stdout.split("\0").filter(Boolean);
  return { ok: true, paths: paths.slice(0, MAX_UNTRACKED_LISTED), total: paths.length };
}
const MAX_FILES_LISTED = 3e3;
async function gitListFiles(root2) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  const res = await runGit(real, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!res.ok) return { ok: false, error: gitErrorOf(res) };
  const paths = res.stdout.split("\0").filter(Boolean);
  return { ok: true, paths: paths.slice(0, MAX_FILES_LISTED), total: paths.length };
}
const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ct%x1f%D%x1f%s%x1e";
function parseCommitRecord(record) {
  const f = record.split("");
  if (f.length < 6) return null;
  return {
    hash: f[0],
    shortHash: f[1],
    author: f[2],
    time: Number(f[3]),
    refs: f[4] ? f[4].split(", ").filter(Boolean) : [],
    subject: f[5]
  };
}
async function gitLog(root2, limit = 100) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  const res = await runGit(real, ["log", "-n", String(limit), `--format=${LOG_FORMAT}`]);
  if (!res.ok) {
    if (NO_COMMITS.test(res.stderr) || NOT_A_REPO.test(res.stderr)) return { ok: true, commits: [] };
    return { ok: false, error: gitErrorOf(res) };
  }
  const commits = res.stdout.split("").map((r) => parseCommitRecord(r.replace(/^\n/, ""))).filter((c) => c !== null);
  return { ok: true, commits };
}
const HASH_RE = /^[0-9a-f]{4,40}$/i;
async function gitCommitDetail(root2, hash) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  if (!HASH_RE.test(hash)) return { ok: false, error: "invalid commit hash" };
  const show = await runGit(real, [
    "show",
    "-s",
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ct%x1f%D%x1f%s%x1f%b",
    hash
  ]);
  if (!show.ok) return { ok: false, error: gitErrorOf(show) };
  const f = show.stdout.split("");
  if (f.length < 8) return { ok: false, error: "unexpected git show output" };
  const meta = {
    hash: f[0],
    shortHash: f[1],
    author: f[2],
    time: Number(f[4]),
    refs: f[5] ? f[5].split(", ").filter(Boolean) : [],
    subject: f[6]
  };
  const treeArgs = ["diff-tree", "-r", "--root", "--no-commit-id", "--find-renames", "-z"];
  const [numstat, nameStatus] = await Promise.all([
    runGit(real, [...treeArgs, "--numstat", hash]),
    runGit(real, [...treeArgs, "--name-status", hash])
  ]);
  if (!nameStatus.ok) return { ok: false, error: gitErrorOf(nameStatus) };
  const stats = numstat.ok ? parseNumstat(numstat.stdout) : /* @__PURE__ */ new Map();
  const files = [];
  const tokens = nameStatus.stdout.split("\0");
  for (let i = 0; i < tokens.length - 1; i += 2) {
    const st = tokens[i];
    if (!st) continue;
    const letter = st[0];
    const renamed = letter === "R" || letter === "C";
    const origPath = renamed ? tokens[i + 1] : void 0;
    const path = renamed ? tokens[(i += 1) + 1] : tokens[i + 1];
    if (path === void 0) break;
    const s = stats.get(path);
    files.push({
      path,
      ...origPath !== void 0 && { origPath },
      status: renamed ? letter : statusLetter("1", `${st[0]}.`),
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null
    });
  }
  return { ok: true, meta, authorEmail: f[3], body: f.slice(7).join("").trim(), files };
}
const MAX_DIFF_CHARS$1 = 1e6;
function capDiff(text) {
  if (text.length <= MAX_DIFF_CHARS$1) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", MAX_DIFF_CHARS$1);
  return { text: text.slice(0, cut > 0 ? cut : MAX_DIFF_CHARS$1), truncated: true };
}
async function gitDiff(root2, spec) {
  const real = resolveInsideRoots(root2);
  if (!real) return { ok: false, error: `not readable: ${basename(root2)}` };
  if (spec.kind === "commit") {
    if (!HASH_RE.test(spec.hash)) return { ok: false, error: "invalid commit hash" };
    const paths2 = spec.origPath ? [spec.path, spec.origPath] : [spec.path];
    const res2 = await runGit(real, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--find-renames",
      "-p",
      "--no-color",
      spec.hash,
      "--",
      ...paths2
    ]);
    if (!res2.ok) return { ok: false, error: gitErrorOf(res2) };
    return { ok: true, ...capDiff(res2.stdout) };
  }
  if (spec.untracked) {
    if (spec.path.endsWith("/")) return { ok: false, error: "New folder — open a file inside it" };
    const res2 = await runGit(real, [
      "diff",
      "--no-color",
      "--no-index",
      "--",
      "/dev/null",
      spec.path
    ]);
    if (res2.stdout.startsWith("diff ")) return { ok: true, ...capDiff(res2.stdout) };
    return { ok: false, error: gitErrorOf(res2) };
  }
  const paths = spec.origPath ? [spec.path, spec.origPath] : [spec.path];
  let res = await runGit(real, ["diff", "--no-color", "--find-renames", "HEAD", "--", ...paths]);
  if (!res.ok && NO_COMMITS.test(res.stderr)) {
    res = await runGit(real, ["diff", "--no-color", "--", ...paths]);
  }
  if (!res.ok) return { ok: false, error: gitErrorOf(res) };
  return { ok: true, ...capDiff(res.stdout) };
}
const GIT_INTERNAL_KEEP = /^(HEAD|ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|packed-refs|index|refs(\/|$))/;
const gitWatches = /* @__PURE__ */ new Map();
let nextGitWatchId = 1;
const GIT_DEBOUNCE_MS = 400;
function gitWatchIgnored(path) {
  if (path.includes("/node_modules/") || path.endsWith("/node_modules")) return true;
  const idx = path.indexOf("/.git/");
  if (idx === -1) return false;
  return !GIT_INTERNAL_KEEP.test(path.slice(idx + "/.git/".length));
}
function startGitWatch(win, root2) {
  const real = resolveInsideRoots(root2);
  if (!real || real === homedir()) return -1;
  const id = nextGitWatchId++;
  let timer2 = null;
  const fire = () => {
    if (timer2) clearTimeout(timer2);
    timer2 = setTimeout(() => {
      timer2 = null;
      safeSend(win, "git:changed", { watchId: id });
    }, GIT_DEBOUNCE_MS);
  };
  let watcher2;
  try {
    watcher2 = watch(real, { recursive: true }, (_event, filename) => {
      if (filename === null || !gitWatchIgnored(join(real, filename.toString()))) fire();
    });
  } catch (err) {
    console.error(`git watch ${id}:`, err);
    return -1;
  }
  watcher2.on("error", (err) => {
    console.error(`git watch ${id}:`, err);
  });
  gitWatches.set(id, {
    watcher: watcher2,
    cancelPending: () => {
      if (timer2) clearTimeout(timer2);
      timer2 = null;
    }
  });
  return id;
}
function stopGitWatch(watchId) {
  const entry = gitWatches.get(watchId);
  if (!entry) return;
  entry.cancelPending();
  entry.watcher.close();
  gitWatches.delete(watchId);
}
function disposeAllGitWatches() {
  for (const id of [...gitWatches.keys()]) stopGitWatch(id);
}
const NETWORK_TIMEOUT_MS$1 = 12e4;
const okWith = (r, fallback) => {
  const lines = `${r.stdout}
${r.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return { ok: true, message: lines.at(-1) ?? fallback };
};
async function gitFetch(cwd) {
  const remotes = await runGit(cwd, ["remote"]);
  if (!remotes.stdout.trim()) return { ok: false, error: "No remote configured" };
  const res = await runGit(cwd, ["fetch", "origin", "--prune"], NETWORK_TIMEOUT_MS$1);
  return res.ok ? okWith(res, "Fetched") : { ok: false, error: gitErrorOf(res) };
}
async function gitFetchRemote(root2) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return { ok: false, error: `not readable: ${basename(root2)}` };
  return gitFetch(cwd);
}
async function gitDefaultBase(root2) {
  const cwd = resolveInsideRoots(root2);
  return cwd ? defaultRemoteRef(cwd) : null;
}
async function gitSwitchBranch(root2, branch) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return { ok: false, error: `not readable: ${basename(root2)}` };
  if (!branch.trim() || branch.startsWith("-")) return { ok: false, error: "Not a valid branch name" };
  const res = await runGit(cwd, ["switch", branch]);
  return res.ok ? okWith(res, `On ${branch}`) : { ok: false, error: gitErrorOf(res) };
}
async function gitUpdateFromBase(root2) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return { ok: false, error: `not readable: ${basename(root2)}` };
  const fetched = await gitFetch(cwd);
  if (!fetched.ok) return fetched;
  const base = await defaultRemoteRef(cwd);
  if (!base) return { ok: false, error: "Could not tell which branch origin defaults to." };
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return { ok: false, error: gitErrorOf(head) };
  const branch = head.stdout.trim();
  if (branch === "HEAD") return { ok: false, error: "Detached HEAD — nothing to update." };
  const onBase = branch === base.slice(base.indexOf("/") + 1);
  const res = await runGit(
    cwd,
    onBase ? ["merge", "--ff-only", base] : ["merge", "--no-edit", base],
    NETWORK_TIMEOUT_MS$1
  );
  if (res.ok) return okWith(res, `Up to date with ${base}`);
  const midMerge = await runGit(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (midMerge.ok) {
    await runGit(cwd, ["merge", "--abort"]);
    return {
      ok: false,
      error: `${gitErrorOf(res)}

The merge was aborted — this checkout is untouched.`
    };
  }
  return { ok: false, error: gitErrorOf(res) };
}
const WORKTREES_ROOT = join(homedir(), ".chewo", "worktrees");
const TASK_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
function validateTaskName(name) {
  if (!name.trim()) return "Task name is required";
  if (name.length > 60) return "Task name too long (max 60 chars)";
  if (!TASK_NAME_RE.test(name))
    return "Use letters, digits, dots, dashes or underscores; start with a letter or digit";
  if (name.includes("..") || name.endsWith(".lock"))
    return "Task name is not a valid git branch name";
  return null;
}
const branchFor = (taskName) => `agent/${taskName}`;
function worktreeDirFor(projectPath, taskName) {
  return join(WORKTREES_ROOT, basename(projectPath), taskName);
}
async function listBranches(projectPath) {
  const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` };
  const head = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const refs = await runGit(projectPath, [
    "for-each-ref",
    "--format=%(refname)%00%(refname:short)%00%(symref)%00%(objectname)",
    "--sort=-committerdate",
    "refs/heads",
    "refs/remotes"
  ]);
  if (!refs.ok) return { ok: false, error: gitErrorOf(refs) };
  const local = [];
  const remote = [];
  const commits = /* @__PURE__ */ new Map();
  for (const line of refs.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const [refname, short, symref, objectname] = line.split("\0");
    if (!short || symref) continue;
    commits.set(refname, objectname);
    if (refname.startsWith("refs/heads/")) local.push(short);
    else remote.push(short);
  }
  const twin = await localTwinOfDefault(projectPath, commits);
  const shown = twin ? local.filter((b) => b !== twin) : local;
  return { ok: true, current: head.ok ? head.stdout.trim() : "HEAD", local: shown, remote };
}
async function localTwinOfDefault(projectPath, commits) {
  const base = await defaultRemoteRef(projectPath);
  if (!base) return null;
  const sha = commits.get(`refs/remotes/${base}`);
  if (!sha) return null;
  const slash = base.indexOf("/");
  if (slash < 0) return null;
  const name = base.slice(slash + 1);
  return commits.get(`refs/heads/${name}`) === sha ? name : null;
}
async function creationCommit(projectPath, branch) {
  if (!branch) return void 0;
  const res = await runGit(projectPath, ["reflog", "show", "--no-abbrev", "--format=%H", branch]);
  if (!res.ok) return void 0;
  const entries = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  return entries.at(-1);
}
async function listWorktrees(projectPath) {
  const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` };
  const res = await runGit(projectPath, ["worktree", "list", "--porcelain"]);
  if (!res.ok) return { ok: false, error: gitErrorOf(res) };
  const ours = join(WORKTREES_ROOT, basename(projectPath)) + "/";
  const found = [];
  let path = "";
  let branch = "";
  const flush = () => {
    if (path.startsWith(ours)) found.push({ path, branch, taskName: basename(path) });
    path = "";
    branch = "";
  };
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  flush();
  for (const w of found) w.baseCommit = await creationCommit(projectPath, w.branch);
  const head = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { ok: true, head: head.ok ? head.stdout.trim() : "HEAD", worktrees: found };
}
async function worktreeState(projectPath, worktreePath, branch, baseCommit) {
  const missing = !existsSync(worktreePath);
  const dead = {
    missing,
    branchExists: false,
    ahead: 0,
    behind: 0,
    dirty: 0,
    merged: false
  };
  if (!branch) return dead;
  const tip = await runGit(projectPath, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  if (!tip.ok) return dead;
  const head = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const target = head.ok ? head.stdout.trim() : "HEAD";
  const counts = await runGit(projectPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${target}...${branch}`
  ]);
  const [behindRaw, aheadRaw] = counts.ok ? counts.stdout.trim().split(/\s+/) : [];
  const ahead = Number(aheadRaw) || 0;
  const behind = Number(behindRaw) || 0;
  const status = missing ? null : await runGit(worktreePath, ["status", "--porcelain"]);
  const dirty = status?.ok ? status.stdout.split("\n").filter((l) => l.trim()).length : 0;
  const start = baseCommit ?? await creationCommit(projectPath, branch);
  return {
    missing,
    branchExists: true,
    ahead,
    behind,
    dirty,
    merged: ahead === 0 && dirty === 0 && !!start && start !== tip.stdout.trim()
  };
}
function validateBaseRef(base) {
  if (!base.trim()) return "Base branch is required";
  if (base.startsWith("-")) return "Base branch is not a valid git ref";
  return null;
}
async function freshestBase(projectPath, remoteRef) {
  const local = remoteRef.slice(remoteRef.indexOf("/") + 1);
  const exists = await runGit(projectPath, ["show-ref", "--verify", "--quiet", `refs/heads/${local}`]);
  if (!exists.ok) return remoteRef;
  const ahead = await runGit(projectPath, ["rev-list", "--count", `${remoteRef}..${local}`]);
  return ahead.ok && Number(ahead.stdout.trim()) > 0 ? local : remoteRef;
}
async function remoteOf(projectPath, ref) {
  const slash = ref.indexOf("/");
  if (slash <= 0) return null;
  const exists = await runGit(projectPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`]);
  return exists.ok ? ref.slice(0, slash) : null;
}
async function createWorktree(projectPath, taskName, base) {
  const invalid = validateTaskName(taskName);
  if (invalid) return { ok: false, error: invalid };
  const inside = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: `${basename(projectPath)} is not a git repository` };
  const dir = worktreeDirFor(projectPath, taskName);
  if (existsSync(dir)) return { ok: false, error: `Worktree folder already exists: ${dir}` };
  let baseBranch;
  let baseCommit;
  if (base === void 0) {
    await runGit(projectPath, ["fetch", "origin", "--prune"], 12e4);
    const remote = await defaultRemoteRef(projectPath);
    const start = remote ? await freshestBase(projectPath, remote) : null;
    const rev = start ? await runGit(projectPath, ["rev-parse", "--verify", "--quiet", `${start}^{commit}`]) : { ok: false, stdout: "" };
    if (start && rev.ok) {
      baseBranch = start;
      baseCommit = rev.stdout.trim();
    } else {
      const head = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      baseBranch = head.ok ? head.stdout.trim() : "HEAD";
      const local = await runGit(projectPath, ["rev-parse", "HEAD"]);
      baseCommit = local.ok ? local.stdout.trim() : "";
    }
  } else {
    const badBase = validateBaseRef(base);
    if (badBase) return { ok: false, error: badBase };
    const remote = await remoteOf(projectPath, base);
    if (remote) await runGit(projectPath, ["fetch", remote, "--prune"], 12e4);
    const rev = await runGit(projectPath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (!rev.ok) return { ok: false, error: `Base branch not found: ${base}` };
    baseBranch = base;
    baseCommit = rev.stdout.trim();
  }
  const branch = branchFor(taskName);
  const res = await runGit(
    projectPath,
    ["worktree", "add", "--no-track", "-b", branch, dir, baseBranch],
    3e5
  );
  if (!res.ok) return { ok: false, error: gitErrorOf(res) };
  return { ok: true, path: dir, branch, baseBranch, baseCommit };
}
function cloneNodeModules(projectPath, worktreePath) {
  const source = join(projectPath, "node_modules");
  const dest = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(dest)) return Promise.resolve(null);
  const staged = join(dirname(worktreePath), `.${basename(worktreePath)}.node_modules.staged`);
  rmSync(staged, { recursive: true, force: true });
  return new Promise((resolve2) => {
    execFile("/bin/cp", ["-cRp", source, staged], { timeout: 3e5 }, (err, _out, stderr) => {
      if (!err) {
        try {
          if (existsSync(dest)) rmSync(staged, { recursive: true, force: true });
          else renameSync(staged, dest);
          return resolve2(null);
        } catch (e) {
          rmSync(staged, { recursive: true, force: true });
          return resolve2(e instanceof Error ? e.message : String(e));
        }
      }
      rmSync(staged, { recursive: true, force: true });
      resolve2(String(stderr).trim().split("\n")[0] || err.message);
    });
  });
}
const MAX_LOCAL_FILES = 100;
async function copyLocalFiles(projectPath, worktreePath, patterns) {
  const listed = await runGit(projectPath, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory"
  ]);
  if (!listed.ok) return { copied: [], error: gitErrorOf(listed) };
  const entries = listed.stdout.split("\0").filter(Boolean);
  const copied = [];
  let error;
  for (const entry of entries) {
    if (copied.length >= MAX_LOCAL_FILES) {
      error = `stopped after ${MAX_LOCAL_FILES} files — narrow the copy patterns`;
      break;
    }
    const top = entry.split("/")[0];
    if (top === "node_modules" || top === ".git") continue;
    if (!matchesLocalFile(entry, patterns)) continue;
    const dest = join(worktreePath, entry.replace(/\/$/, ""));
    if (existsSync(dest)) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(projectPath, entry), dest, { recursive: true, preserveTimestamps: true });
      copied.push(entry);
    } catch (err) {
      error ??= `${entry}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { copied, error };
}
async function removeWorktree(projectPath, worktreePath, branch, discard = false) {
  const rm = await runGit(
    projectPath,
    discard ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath],
    12e4
  );
  if (!rm.ok) {
    if (existsSync(worktreePath)) return { ok: false, error: gitErrorOf(rm) };
    const pruned = await runGit(projectPath, ["worktree", "prune"]);
    if (!pruned.ok) return { ok: false, error: gitErrorOf(pruned) };
  }
  if (!branch) return { ok: true, branchDeleted: false };
  const br = await runGit(projectPath, ["branch", discard ? "-D" : "-d", branch]);
  return br.ok ? { ok: true, branchDeleted: true } : { ok: true, branchDeleted: false, note: `Worktree removed; branch kept: ${gitErrorOf(br)}` };
}
async function pruneMergedBranches(projectPath, merged) {
  if (!merged.length) return [];
  const held = await heldBranches(projectPath);
  if (!held) return [];
  const refs = await runGit(projectPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!refs.ok) return [];
  const local = new Set(refs.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const deleted = [];
  for (const branch of new Set(merged)) {
    if (!local.has(branch) || held.has(branch)) continue;
    if ((await runGit(projectPath, ["branch", "-d", branch])).ok) deleted.push(branch);
  }
  return deleted;
}
async function heldBranches(projectPath) {
  const wt = await runGit(projectPath, ["worktree", "list", "--porcelain"]);
  if (!wt.ok) return null;
  const held = new Set(
    wt.stdout.split("\n").filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch ".length).trim().replace(/^refs\/heads\//, ""))
  );
  const head = await runGit(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.ok) held.add(head.stdout.trim());
  const base = await defaultRemoteRef(projectPath);
  if (base) held.add(base.replace(/^[^/]+\//, ""));
  return held;
}
async function pruneCandidates(projectPath) {
  const base = await defaultRemoteRef(projectPath);
  if (!base) return [];
  const held = await heldBranches(projectPath);
  if (!held) return [];
  const refs = await runGit(projectPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "--merged",
    base,
    "refs/heads"
  ]);
  if (!refs.ok) return [];
  return refs.stdout.split("\n").map((s) => s.trim()).filter((b) => b && !held.has(b));
}
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const IGNORED_NAMES = /* @__PURE__ */ new Set([".git", "node_modules"]);
const IMAGE_MIMES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif"
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
function allowedRoots() {
  const roots = [homedir(), WORKTREES_ROOT, ...loadProjects().projects.map((p) => p.path)];
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
}
function resolveInsideRoots(path) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  for (const root2 of allowedRoots()) {
    if (real === root2 || real.startsWith(root2 + sep)) return real;
  }
  return null;
}
function readDir(path) {
  const real = resolveInsideRoots(path);
  if (!real) return { ok: false, error: `not readable: ${basename(path)}` };
  try {
    const entries = readdirSync(real, { withFileTypes: true }).map((d) => {
      const entryPath = join(real, d.name);
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          isDir = statSync(entryPath).isDirectory();
        } catch {
          isDir = false;
        }
      }
      return {
        name: d.name,
        path: entryPath,
        isDir,
        isSymlink: d.isSymbolicLink(),
        isIgnored: isDir && IGNORED_NAMES.has(d.name)
      };
    });
    entries.sort(
      (a, b) => a.isDir !== b.isDir ? a.isDir ? -1 : 1 : a.name.localeCompare(b.name)
    );
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
function isFile(path) {
  const real = resolveInsideRoots(path);
  if (!real) return false;
  try {
    return statSync(real).isFile();
  } catch {
    return false;
  }
}
function readFile(path) {
  const real = resolveInsideRoots(path);
  if (!real) {
    let exists = true;
    try {
      statSync(path);
    } catch {
      exists = false;
    }
    return exists ? { ok: false, error: `not readable: ${basename(path)}`, reason: "denied" } : { ok: false, error: "File not found", reason: "not-found" };
  }
  try {
    const stat = statSync(real);
    const ext = real.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "pdf") {
      if (stat.size > MAX_PDF_BYTES)
        return {
          ok: false,
          error: `PDF too large (${Math.round(stat.size / 1024 / 1024)} MB)`,
          reason: "too-large"
        };
      const dataUrl = `data:application/pdf;base64,${readFileSync(real).toString("base64")}`;
      return { ok: true, kind: "pdf", dataUrl, mtimeMs: stat.mtimeMs };
    }
    const mime = IMAGE_MIMES[ext];
    if (mime) {
      if (stat.size > MAX_IMAGE_BYTES)
        return {
          ok: false,
          error: `Image too large (${Math.round(stat.size / 1024)} KB)`,
          reason: "too-large"
        };
      const dataUrl = `data:${mime};base64,${readFileSync(real).toString("base64")}`;
      return { ok: true, kind: "image", dataUrl, mtimeMs: stat.mtimeMs };
    }
    if (stat.size > MAX_FILE_BYTES)
      return {
        ok: false,
        error: `File too large (${Math.round(stat.size / 1024)} KB)`,
        reason: "too-large"
      };
    const buffer = readFileSync(real);
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0))
      return {
        ok: false,
        error: `Binary file (${Math.round(stat.size / 1024)} KB)`,
        reason: "binary"
      };
    return { ok: true, kind: "text", content: buffer.toString("utf8"), mtimeMs: stat.mtimeMs };
  } catch (err) {
    const code = err.code;
    return code === "ENOENT" ? { ok: false, error: "File not found", reason: "not-found" } : { ok: false, error: err instanceof Error ? err.message : String(err), reason: "io" };
  }
}
function writeFile(path, content) {
  const real = resolveInsideRoots(path);
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` };
  try {
    writeFileSync(real, content);
    return { ok: true, mtimeMs: statSync(real).mtimeMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
const opFail = (err) => ({
  ok: false,
  error: err instanceof Error ? err.message : String(err)
});
const invalidName = (name) => !name || name === "." || name === ".." || /[/\\:\0]/.test(name);
function renameEntry(path, newName) {
  const real = resolveInsideRoots(path);
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` };
  if (invalidName(newName)) return { ok: false, error: "Invalid name" };
  const target = join(dirname(real), newName);
  if (existsSync(target)) return { ok: false, error: `"${newName}" already exists` };
  try {
    renameSync(real, target);
    return { ok: true, path: target };
  } catch (err) {
    return opFail(err);
  }
}
async function deleteEntry(path) {
  const real = resolveInsideRoots(path);
  if (!real) return { ok: false, error: `not writable: ${basename(path)}` };
  try {
    await shell.trashItem(real);
    return { ok: true, path: real };
  } catch (err) {
    return opFail(err);
  }
}
function availableName(destDir, name) {
  if (!existsSync(join(destDir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!existsSync(join(destDir, candidate))) return candidate;
  }
}
function copyEntry(srcPath, destDir) {
  const src = resolveInsideRoots(srcPath);
  const dest = resolveInsideRoots(destDir);
  if (!src || !dest) return { ok: false, error: "not writable" };
  if (dest === src || dest.startsWith(src + sep))
    return { ok: false, error: "Can't copy a folder into itself" };
  try {
    const target = join(dest, availableName(dest, basename(src)));
    cpSync(src, target, { recursive: true });
    return { ok: true, path: target };
  } catch (err) {
    return opFail(err);
  }
}
function moveEntry(srcPath, destDir) {
  const src = resolveInsideRoots(srcPath);
  const dest = resolveInsideRoots(destDir);
  if (!src || !dest) return { ok: false, error: "not writable" };
  if (dest === src || dest.startsWith(src + sep))
    return { ok: false, error: "Can't move a folder into itself" };
  if (dirname(src) === dest) return { ok: true, path: src };
  const target = join(dest, availableName(dest, basename(src)));
  try {
    renameSync(src, target);
    return { ok: true, path: target };
  } catch (err) {
    if (err.code !== "EXDEV") return opFail(err);
    try {
      cpSync(src, target, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      return { ok: true, path: target };
    } catch (copyErr) {
      return opFail(copyErr);
    }
  }
}
function createEntry(dirPath, name, isDir) {
  const dir = resolveInsideRoots(dirPath);
  if (!dir) return { ok: false, error: `not writable: ${basename(dirPath)}` };
  if (invalidName(name)) return { ok: false, error: "Invalid name" };
  const target = join(dir, name);
  if (existsSync(target)) return { ok: false, error: `"${name}" already exists` };
  try {
    if (isDir) mkdirSync(target);
    else writeFileSync(target, "", { flag: "wx" });
    return { ok: true, path: target };
  } catch (err) {
    return opFail(err);
  }
}
function revealEntry(path) {
  const real = resolveInsideRoots(path);
  if (!real) return { ok: false, error: `not readable: ${basename(path)}` };
  shell.showItemInFolder(real);
  return { ok: true, path: real };
}
const watches = /* @__PURE__ */ new Map();
let nextWatchId = 1;
const DEBOUNCE_MS = 300;
function startWatch(win) {
  const id = nextWatchId++;
  const entry = {
    watcher: chokidar.watch([], { ignoreInitial: true, depth: 0 }),
    timer: null,
    pending: /* @__PURE__ */ new Set()
  };
  entry.watcher.on("all", (_event, path) => {
    entry.pending.add(path);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const paths = [...entry.pending];
      entry.pending.clear();
      entry.timer = null;
      safeSend(win, "fs:changed", { watchId: id, paths });
    }, DEBOUNCE_MS);
  });
  entry.watcher.on("error", (err) => {
    console.error(`file-explorer watch ${id}:`, err);
  });
  watches.set(id, entry);
  return id;
}
function watchAdd(watchId, path) {
  const real = resolveInsideRoots(path);
  const entry = watches.get(watchId);
  if (entry && real) entry.watcher.add(real);
}
function watchRemove(watchId, path) {
  const real = resolveInsideRoots(path);
  const entry = watches.get(watchId);
  if (entry && real) void entry.watcher.unwatch(real);
}
function stopWatch(watchId) {
  const entry = watches.get(watchId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  void entry.watcher.close();
  watches.delete(watchId);
}
function disposeAllWatches() {
  for (const id of [...watches.keys()]) stopWatch(id);
}
const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 15e3;
const cache = /* @__PURE__ */ new Map();
function parseCodexModels(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  return (parsed.models ?? []).filter((m) => m.visibility === "list" && typeof m.slug === "string").sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)).map((m) => {
    const efforts = (m.supported_reasoning_levels ?? []).map((e) => e.effort).filter((e) => typeof e === "string" && e.length > 0);
    return {
      id: m.slug,
      label: m.display_name || m.slug,
      // Per-model, not per-agent: gpt-5.5 has no 'max', gpt-5.6-sol adds 'ultra'
      efforts: efforts.length ? efforts : EFFORT_LEVELS,
      detail: m.description
    };
  });
}
async function listAgentModels(agent) {
  const cached2 = cache.get(agent);
  if (cached2) return cached2;
  const def = agentDef(agent);
  if (!def.discoverable) {
    cache.set(agent, def.models);
    return def.models;
  }
  try {
    const { stdout } = await execFileAsync("/bin/zsh", ["-ilc", `${def.bin} debug models`], {
      env: buildPtyEnv(process.env),
      timeout: DISCOVERY_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024
    });
    const models = parseCodexModels(stdout);
    if (models.length) {
      cache.set(agent, models);
      return models;
    }
  } catch {
  }
  return def.models;
}
const MAX_LISTED = 24;
function orchestratorBrief(agents) {
  if (agents.length === 0) return "";
  const listed = agents.slice(0, MAX_LISTED);
  const roster = listed.map((a) => `- ${a.name}: ${a.description}`);
  return [
    "# Working as a lead",
    "",
    "For this session you coordinate specialist subagents rather than doing",
    "every part of the work yourself.",
    "",
    "## The roster",
    "",
    ...roster,
    agents.length > listed.length ? `- …and ${agents.length - listed.length} more, listed by the Agent tool.` : "",
    "",
    "## How to work",
    "",
    "1. Read the request and say briefly what you understand it to need. If it",
    "   is ambiguous in a way that changes who should do it, ask first.",
    "2. Break it into tasks with `TaskCreate`, one per unit of work that a",
    "   single agent can finish. Set `owner` to the name of the agent that will",
    "   do it — the owner is how the person watching knows who is on what, so",
    "   never leave it blank on a task you intend to delegate.",
    "3. Dispatch each task with the Agent tool, passing that agent as",
    "   `subagent_type`. Give it everything it needs in the prompt: it cannot",
    "   see this conversation, the files you have read, or what the other",
    "   agents are doing.",
    "4. Move tasks with `TaskUpdate` as they start and finish, so the plan",
    "   stays true while it runs.",
    "5. Read what comes back and judge it. A subagent reporting done is a claim,",
    "   not a result — if it does not hold up, say so and dispatch again.",
    "",
    "## When not to delegate",
    "",
    "Delegation costs a fresh context and a round trip, so it has to buy",
    "something. Do the work yourself, with no task and no dispatch, when:",
    "",
    "- it is a single small edit, a question, or a lookup;",
    "- no agent on the roster covers it, and a general-purpose one would just",
    "  be you with less context;",
    "- it needs the conversation you are in the middle of.",
    "",
    "One agent doing an obvious job directly is a good outcome. A plan with",
    "one task per file, dispatched to agents that were not written for them,",
    "is slower and worse than not planning at all."
  ].filter((line) => line !== "").join("\n");
}
async function dispatchableAgents(cwd) {
  try {
    const plugins = await listInstalledPlugins();
    const projects = cwd ? [{ id: "cwd", name: "project", path: cwd }] : [];
    const inventories = scanCapabilities(projects, { plugins });
    const seen = /* @__PURE__ */ new Set();
    const agents = [];
    for (const inv of inventories) {
      for (const agent of inv.agents) {
        if (agent.origin.kind === "plugin" && !agent.origin.enabled) continue;
        if (!agent.name || seen.has(agent.name)) continue;
        seen.add(agent.name);
        agents.push({
          name: agent.name,
          description: agent.description,
          ...agent.color ? { color: agent.color } : {}
        });
      }
    }
    return agents;
  } catch {
    return [];
  }
}
async function orchestratorPrompt(cwd) {
  return orchestratorBrief(await dispatchableAgents(cwd));
}
const RATE_WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included"
];
function parseAccountUsage(payload, fetchedAt) {
  const windows = /* @__PURE__ */ new Map();
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const entry = value;
        const used = percent(entry.utilization ?? entry.percent);
        if (used !== void 0 && looksLikeWindow(key) && !windows.has(key))
          windows.set(key, { type: key, used, resetsAt: epochSeconds(entry.resets_at) });
      }
      visit(value, depth + 1);
    }
  };
  visit(payload, 0);
  return { windows: [...windows.values()], fetchedAt };
}
function looksLikeWindow(key) {
  return RATE_WINDOWS.includes(key) || /^(one|five|seven|thirty)?_?\d*_?(hour|day|week|month)/.test(key);
}
function percent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  const n = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, n));
}
function epochSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value))
    return value > 1e11 ? Math.round(value / 1e3) : Math.round(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return Math.round(ms / 1e3);
  }
  return void 0;
}
const run = promisify(execFile);
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");
const TTL_MS$1 = 6e4;
const TIMEOUT_MS$2 = 5e3;
let cached$1 = null;
let inFlight$1 = null;
async function credentialsJson() {
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-w"
    ]);
    if (stdout.trim()) return stdout.trim();
  } catch {
  }
  try {
    return await readFile$1(CREDENTIALS_FILE, "utf8");
  } catch {
    return null;
  }
}
function accessToken(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root2 = parsed;
  const oauth = root2?.claudeAiOauth ?? root2;
  const token = oauth?.accessToken;
  if (typeof token !== "string" || !token) return null;
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt === "number" && expiresAt > 0) {
    const ms = expiresAt > 1e11 ? expiresAt : expiresAt * 1e3;
    if (ms < Date.now()) return null;
  }
  return token;
}
async function fetchUsage$1() {
  const raw = await credentialsJson();
  const token = raw && accessToken(raw);
  if (!token) return null;
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${token}`,
        // The header the CLI's own OAuth requests carry; without it the
        // endpoint answers 401 for an OAuth (rather than API-key) token
        "anthropic-beta": "oauth-2025-04-20",
        accept: "application/json"
      },
      signal: AbortSignal.timeout(TIMEOUT_MS$2)
    });
    if (!res.ok) return null;
    const usage = parseAccountUsage(await res.json(), Date.now());
    return usage.windows.length > 0 ? usage : null;
  } catch {
    return null;
  }
}
function accountUsage(force = false) {
  const fresh = cached$1 && Date.now() - cached$1.at < TTL_MS$1;
  if (fresh && !force) return Promise.resolve(cached$1.value);
  if (inFlight$1) return inFlight$1;
  inFlight$1 = fetchUsage$1().then((value) => {
    cached$1 = { at: Date.now(), value };
    return value;
  }).finally(() => {
    inFlight$1 = null;
  });
  return inFlight$1;
}
const TTL_MS = 6e4;
const TIMEOUT_MS$1 = 5e3;
const RATE_LIMITS_ID = 2;
let cached = null;
let inFlight = null;
function windowType(minutes, priority) {
  if (minutes === 300) return "five_hour";
  if (minutes === 10080) return "seven_day";
  if (!minutes) return priority === 0 ? "primary" : "secondary";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
function rateWindow(value, priority) {
  if (!value || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent))
    return null;
  const duration = typeof value.windowDurationMins === "number" && Number.isFinite(value.windowDurationMins) ? value.windowDurationMins : void 0;
  const resetsAt = typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt) ? value.resetsAt : void 0;
  return {
    type: windowType(duration, priority),
    used: Math.max(0, Math.min(100, value.usedPercent)),
    ...resetsAt ? { resetsAt } : {},
    priority
  };
}
function parseCodexAccountUsage(payload, fetchedAt) {
  if (!payload || typeof payload !== "object") return null;
  const result = payload;
  const buckets = result.rateLimitsByLimitId;
  const byId = buckets && typeof buckets === "object" ? buckets : null;
  const snapshot = byId?.codex ?? result.rateLimits;
  if (!snapshot || typeof snapshot !== "object") return null;
  const windows = [rateWindow(snapshot.primary, 0), rateWindow(snapshot.secondary, 1)].filter(
    (window) => window !== null
  );
  return windows.length ? { windows, fetchedAt } : null;
}
async function fetchUsage() {
  return new Promise((resolve2) => {
    const proc2 = spawn("/bin/zsh", ["-ilc", 'codex "$@"', "chewo", "app-server"], {
      env: buildPtyEnv(process.env)
    });
    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer2);
      proc2.stdin.end();
      proc2.kill();
      resolve2(value);
    };
    const timer2 = setTimeout(() => finish(null), TIMEOUT_MS$1);
    proc2.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === RATE_LIMITS_ID)
          finish(parseCodexAccountUsage(message.result, Date.now()));
      }
    });
    proc2.on("error", () => finish(null));
    proc2.stdin.on("error", () => finish(null));
    proc2.on("close", () => finish(null));
    proc2.stderr.resume();
    for (const message of [
      {
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "chewo", title: "Chewo", version: "1" } }
      },
      { method: "initialized", params: {} },
      { method: "account/rateLimits/read", id: RATE_LIMITS_ID }
    ])
      proc2.stdin.write(`${JSON.stringify(message)}
`);
  });
}
function codexAccountUsage(force = false) {
  const fresh = cached && Date.now() - cached.at < TTL_MS;
  if (fresh && !force) return Promise.resolve(cached.value);
  if (inFlight) return inFlight;
  inFlight = fetchUsage().then((value) => {
    cached = { at: Date.now(), value };
    return value;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
const ATTACHMENTS_DIR = join(homedir(), ".chewo", "attachments");
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
const KEEP_MS = 7 * 24 * 60 * 60 * 1e3;
function stageImage(base64, mimeType) {
  const ext = EXTENSIONS[mimeType];
  if (!ext) throw new Error(`Unsupported image type: ${mimeType}`);
  mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const path = join(ATTACHMENTS_DIR, `${randomUUID()}.${ext}`);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}
function imageBlocks(paths) {
  const blocks = [];
  for (const raw of paths) {
    const path = resolve(raw);
    if (dirname(path) !== ATTACHMENTS_DIR) continue;
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mediaType = Object.entries(EXTENSIONS).find(([, e]) => e === ext)?.[0];
    if (!mediaType) continue;
    try {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") }
      });
    } catch {
      continue;
    }
  }
  return blocks;
}
function pruneAttachments() {
  let names;
  try {
    names = readdirSync(ATTACHMENTS_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - KEEP_MS;
  for (const name of names) {
    const path = join(ATTACHMENTS_DIR, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      continue;
    }
  }
}
const CHAT_TIMEOUT_MS = 5 * 60 * 1e3;
const FIRST_TURN_PREAMBLE = `You are answering questions about the user's lesson notes — markdown files under the current directory, organized Subject/Topic/lesson.md (each lesson may have a .raw.md transcript twin; prefer the structured lesson). Search the notes to find the relevant lessons before answering, and name the lesson file(s) you drew from. Be concise and answer from the notes; say so plainly when the notes don't cover something.

Question: `;
let child = null;
function notesChatCancel() {
  if (!child) return;
  const proc2 = child;
  child = null;
  try {
    proc2.kill();
  } catch {
  }
}
function notesChatSend(win, args) {
  notesChatCancel();
  let scope;
  try {
    scope = resolve(args.scopePath);
    const root2 = resolve(getNotesRoot());
    if (scope !== root2 && !scope.startsWith(root2 + sep))
      throw new Error("scope outside the notes root");
    if (!statSync(scope).isDirectory()) throw new Error("scope folder missing");
  } catch (err) {
    safeSend(win, "noteschat:event", {
      type: "chat_error",
      message: String(err instanceof Error ? err.message : err)
    });
    return;
  }
  const choice2 = agentFor("notesChat");
  const cmd = chatCommand({
    choice: choice2,
    message: args.message,
    resumeSessionId: args.resumeSessionId
  });
  const proc2 = spawn("/bin/zsh", ["-ilc", cmd], { cwd: scope, env: buildPtyEnv(process.env) });
  child = proc2;
  const timeout = setTimeout(() => {
    if (child === proc2) notesChatCancel();
  }, CHAT_TIMEOUT_MS);
  let reportedError = false;
  let buffer = "";
  proc2.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      for (const ev of normalizeChatEvent(choice2.agent, raw)) {
        if (ev.type === "chat_error") reportedError = true;
        safeSend(win, "noteschat:event", ev);
      }
    }
  });
  let stderr = "";
  proc2.stderr.on("data", (d) => stderr += d.toString());
  proc2.on("error", (err) => {
    clearTimeout(timeout);
    if (child === proc2) child = null;
    reportedError = true;
    safeSend(win, "noteschat:event", { type: "chat_error", message: err.message });
  });
  proc2.on("close", (code) => {
    clearTimeout(timeout);
    if (child === proc2) child = null;
    if (code !== 0 && code !== null && !reportedError)
      safeSend(win, "noteschat:event", {
        type: "chat_error",
        message: `${choice2.agent} exited ${code}: ${stderr.slice(0, 200)}`
      });
    safeSend(win, "noteschat:event", { type: "chat_closed" });
  });
  proc2.stdin.write(args.resumeSessionId ? args.message : FIRST_TURN_PREAMBLE + args.message);
  proc2.stdin.end();
}
const TODO_STATUSES = ["blocked", "todo", "in-progress", "done"];
const TODO_STATUS_LABELS = {
  blocked: "Blocked",
  todo: "Todo",
  "in-progress": "In Progress",
  done: "Done"
};
const emptyArchive = () => ({ version: 1, cards: [] });
const emptyBoard = () => ({
  version: 1,
  columns: { blocked: [], todo: [], "in-progress": [], done: [] },
  cards: {}
});
const GENERAL_SCOPE = "general";
const djb2Hex = (input) => {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
function projectScopeDir(name, path) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";
  return `p-${slug}-${djb2Hex(path)}`;
}
function statusOf(board, cardId) {
  for (const status of TODO_STATUSES) {
    if (board.columns[status].includes(cardId)) return status;
  }
  return null;
}
let root = join(homedir(), ".chewo", "todos");
const todosRoot = () => root;
function todosRootPath() {
  mkdirSync(root, { recursive: true });
  return root;
}
function scopePath(scopeDir) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scopeDir)) throw new Error(`bad scope: ${scopeDir}`);
  const dir = join(todosRoot(), scopeDir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  return dir;
}
function loadBoard(scopeDir) {
  const dir = scopePath(scopeDir);
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "board.json"), "utf8"));
    const board = emptyBoard();
    for (const status of TODO_STATUSES) {
      board.columns[status] = (parsed.columns?.[status] ?? []).filter(
        (id) => parsed.cards?.[id]
      );
    }
    board.cards = parsed.cards ?? {};
    return board;
  } catch {
    return emptyBoard();
  }
}
function saveBoard(scopeDir, board) {
  writeFileSync(join(scopePath(scopeDir), "board.json"), JSON.stringify(board, null, 2));
}
let onCommit = null;
function setCommitListener(fn) {
  onCommit = fn;
}
function commit(scopeDir, board) {
  saveBoard(scopeDir, board);
  onCommit?.(scopeDir);
  return board;
}
function addCard(scopeDir, title, status = "todo", text) {
  const board = loadBoard(scopeDir);
  const trimmed = title.trim();
  if (!trimmed) return board;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const card = {
    id: randomUUID(),
    title: trimmed,
    text: text?.trim() || void 0,
    createdAt: now,
    updatedAt: now
  };
  board.cards[card.id] = card;
  board.columns[status].unshift(card.id);
  return commit(scopeDir, board);
}
function restoreBoard(scopeDir, board) {
  return commit(scopeDir, board);
}
function restoreAssets(scopeDir, files) {
  const assetsDir2 = join(scopePath(scopeDir), "assets");
  for (const file of files) {
    if (!/^[a-z0-9-]+\.png$/.test(file.name)) continue;
    writeFileSync(join(assetsDir2, file.name), Buffer.from(file.base64, "base64"));
  }
}
function moveCard(scopeDir, cardId, to) {
  const board = loadBoard(scopeDir);
  if (!board.cards[cardId]) return board;
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId);
  }
  board.columns[to].unshift(cardId);
  board.cards[cardId].updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return commit(scopeDir, board);
}
function updateCard(args) {
  const board = loadBoard(args.scopeDir);
  const card = board.cards[args.cardId];
  if (!card) return board;
  const assetsDir2 = join(scopePath(args.scopeDir), "assets");
  const kept = (card.images ?? []).filter((name) => !args.removeImages.includes(name));
  for (const name of args.removeImages) {
    if (card.images?.includes(name)) rmSync(join(assetsDir2, name), { force: true });
  }
  const added = [];
  for (const data of args.addImages) {
    const name = `${randomUUID()}.png`;
    writeFileSync(join(assetsDir2, name), Buffer.from(data, "base64"));
    added.push(name);
  }
  card.title = args.title.trim() || card.title;
  card.text = args.text.trim() || void 0;
  const images = [...kept, ...added];
  card.images = images.length > 0 ? images : void 0;
  card.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return commit(args.scopeDir, board);
}
function deleteCard(scopeDir, cardId) {
  const board = loadBoard(scopeDir);
  const card = board.cards[cardId];
  if (!card) return board;
  const assetsDir2 = join(scopePath(scopeDir), "assets");
  for (const name of card.images ?? []) rmSync(join(assetsDir2, name), { force: true });
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId);
  }
  delete board.cards[cardId];
  return commit(scopeDir, board);
}
function assetsDir(scopeDir) {
  return join(scopePath(scopeDir), "assets");
}
function markCardRun(scopeDir, cardId) {
  const board = loadBoard(scopeDir);
  const card = board.cards[cardId];
  if (!card) return board;
  for (const status of TODO_STATUSES) {
    board.columns[status] = board.columns[status].filter((id) => id !== cardId);
  }
  board.columns["in-progress"].unshift(cardId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  card.lastRunAt = now;
  card.updatedAt = now;
  return commit(scopeDir, board);
}
function loadArchive(scopeDir) {
  const dir = scopePath(scopeDir);
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "archive.json"), "utf8"));
    return { version: 1, cards: (parsed.cards ?? []).filter((c) => c?.id && c.title) };
  } catch {
    return emptyArchive();
  }
}
function saveArchive(scopeDir, archive) {
  writeFileSync(join(scopePath(scopeDir), "archive.json"), JSON.stringify(archive, null, 2));
}
function archiveDone(scopeDir) {
  const board = loadBoard(scopeDir);
  if (board.columns.done.length === 0) return board;
  const archive = loadArchive(scopeDir);
  const archivedAt = (/* @__PURE__ */ new Date()).toISOString();
  for (const id of board.columns.done) {
    const card = board.cards[id];
    if (!card) continue;
    archive.cards.unshift({ ...card, archivedAt });
    delete board.cards[id];
  }
  board.columns.done = [];
  saveArchive(scopeDir, archive);
  return commit(scopeDir, board);
}
function restoreArchived(scopeDir, cardId) {
  const archive = loadArchive(scopeDir);
  const card = archive.cards.find((c) => c.id === cardId);
  if (!card) return loadBoard(scopeDir);
  archive.cards = archive.cards.filter((c) => c.id !== cardId);
  const board = loadBoard(scopeDir);
  const { archivedAt: _archivedAt, ...restored } = card;
  board.cards[card.id] = { ...restored, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  board.columns.todo.unshift(card.id);
  saveArchive(scopeDir, archive);
  return commit(scopeDir, board);
}
function deleteArchived(scopeDir, cardId) {
  const archive = loadArchive(scopeDir);
  const card = archive.cards.find((c) => c.id === cardId);
  if (!card) return archive;
  const assetsDir2 = join(scopePath(scopeDir), "assets");
  for (const name of card.images ?? []) rmSync(join(assetsDir2, name), { force: true });
  archive.cards = archive.cards.filter((c) => c.id !== cardId);
  saveArchive(scopeDir, archive);
  onCommit?.(scopeDir);
  return archive;
}
function emptyArchiveFile(scopeDir) {
  const archive = loadArchive(scopeDir);
  const assetsDir2 = join(scopePath(scopeDir), "assets");
  for (const card of archive.cards) {
    for (const name of card.images ?? []) rmSync(join(assetsDir2, name), { force: true });
  }
  const emptied = emptyArchive();
  saveArchive(scopeDir, emptied);
  onCommit?.(scopeDir);
  return emptied;
}
function deleteScope(scopeDir) {
  rmSync(scopePath(scopeDir), { recursive: true, force: true });
  onCommit?.(scopeDir);
}
function readAsset(scopeDir, fileName) {
  if (!/^[a-z0-9-]+\.png$/.test(fileName)) return null;
  try {
    const data = readFileSync(join(scopePath(scopeDir), "assets", fileName));
    return `data:image/png;base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}
function setTodosWindow(win) {
  setCommitListener((scopeDir) => safeSend(win, "todos:changed", { scopeDir }));
}
const indexPath = () => join(todosRootPath(), "scopes.json");
const GENERAL = { dir: GENERAL_SCOPE, name: "General" };
function writeScopeIndex(scopes) {
  const file = {
    version: 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    scopes: [GENERAL, ...scopes.filter((s) => s.dir !== GENERAL_SCOPE)]
  };
  writeFileSync(indexPath(), JSON.stringify(file, null, 2));
}
const filePath = () => join(app.getPath("userData"), "credentials.json");
function load() {
  try {
    return JSON.parse(readFileSync(filePath(), "utf8"));
  } catch {
    return {};
  }
}
function save(file) {
  const path = filePath();
  if (Object.keys(file).length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 384 });
}
function hasDeepgramKey() {
  return deepgramKey() !== null;
}
function deepgramKey() {
  const stored = load().deepgram;
  if (!stored) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return null;
  }
}
function setDeepgramKey(key) {
  const trimmed = key.trim();
  if (!trimmed) return "Enter a Deepgram API key.";
  if (!safeStorage.isEncryptionAvailable())
    return "macOS Keychain is unavailable, so the key cannot be stored securely.";
  save({ ...load(), deepgram: safeStorage.encryptString(trimmed).toString("base64") });
  return null;
}
function clearDeepgramKey() {
  const file = load();
  delete file.deepgram;
  save(file);
}
const STREAM_ENCODING = "linear16";
const STREAM_SAMPLE_RATE = 16e3;
const STREAM_CHANNELS = 1;
const KEEPALIVE_EVERY_MS = 4e3;
const KEEPALIVE_IDLE_MS = 3e3;
const FLUSH_TIMEOUT_MS = 6e3;
const PARAGRAPH_GAP_S = 1.75;
const MAX_SENTENCES_PER_PARAGRAPH = 4;
class TranscriptAssembler {
  confirmed = "";
  tail = "";
  previousEnd = null;
  sentencesSinceBreak = 0;
  /** True when the snapshot changed and the UI is worth updating. */
  accept(message) {
    if (message.type !== "Results") return false;
    const text = (message.channel.alternatives[0]?.transcript ?? "").trim();
    if (!message.is_final) {
      if (text === this.tail) return false;
      this.tail = text;
      return true;
    }
    if (!text) {
      const hadTail = this.tail !== "";
      this.tail = "";
      return hadTail;
    }
    this.append(text, message.start, message.start + message.duration);
    this.tail = "";
    return true;
  }
  append(text, start, end) {
    if (this.previousEnd !== null) {
      const longPause = start - this.previousEnd > PARAGRAPH_GAP_S;
      const budgetSpent = this.sentencesSinceBreak >= MAX_SENTENCES_PER_PARAGRAPH && endsSentence(this.confirmed);
      if (longPause || budgetSpent) {
        this.confirmed += "\n\n";
        this.sentencesSinceBreak = 0;
      } else if (this.confirmed) {
        this.confirmed += " ";
      }
    } else if (this.confirmed) {
      this.confirmed += " ";
    }
    this.confirmed += text;
    this.sentencesSinceBreak += [...text].filter((c) => ".!?".includes(c)).length;
    this.previousEnd = end;
  }
  snapshot() {
    return { confirmed: this.confirmed, tail: this.tail };
  }
  /** Everything said, for the `final` event — the tail is included because a
   * recording stopped mid-sentence still has words in it. */
  text() {
    return [this.confirmed, this.tail].filter(Boolean).join(" ").trim();
  }
}
function endsSentence(text) {
  const last = text.trimEnd().slice(-1);
  return last !== "" && ".!?".includes(last);
}
async function openDeepgramStream(options) {
  const client = new DeepgramClient({ apiKey: options.apiKey });
  const assembler = new TranscriptAssembler();
  const socket = await client.listen.v1.connect({
    Authorization: `Token ${options.apiKey}`,
    model: options.model,
    language: options.language,
    encoding: STREAM_ENCODING,
    sample_rate: STREAM_SAMPLE_RATE,
    channels: STREAM_CHANNELS,
    // v5 sends WebSocket options as query params, so booleans go on the wire
    // as strings. Passing real booleans here silently drops them.
    interim_results: "true",
    smart_format: "true",
    // Both set explicitly: the API reference and the SDK examples disagree
    // about the defaults, so neither is worth inheriting.
    endpointing: 300,
    utterance_end_ms: 1e3,
    ...options.keyterms?.length ? { keyterm: options.keyterms } : {},
    // A blip mid-lecture is worth riding out; a dead network is not, and the
    // on-disk PCM is the real safety net either way (src/main/stt.ts).
    reconnectAttempts: 3
  });
  let lastMediaAt = Date.now();
  let closed = false;
  let flushed = null;
  socket.on("message", (message) => {
    if (message.type === "Results") {
      if (assembler.accept(message)) options.onPartial(assembler.snapshot());
      return;
    }
    if (message.type === "Metadata") flushed?.();
  });
  socket.on("error", (error) => {
    options.onError(error.message || "Deepgram connection error");
  });
  socket.on("close", () => {
    closed = true;
    flushed?.();
  });
  socket.connect();
  await socket.waitForOpen();
  const keepAlive = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastMediaAt < KEEPALIVE_IDLE_MS) return;
    try {
      socket.sendKeepAlive({ type: "KeepAlive" });
    } catch {
    }
  }, KEEPALIVE_EVERY_MS);
  keepAlive.unref();
  const teardown = () => {
    clearInterval(keepAlive);
    try {
      socket.close();
    } catch {
    }
  };
  return {
    send(pcm) {
      if (closed) return;
      lastMediaAt = Date.now();
      try {
        socket.sendMedia(pcm);
      } catch {
      }
    },
    async finish() {
      if (!closed) {
        try {
          socket.sendCloseStream({ type: "CloseStream" });
          await new Promise((resolve2) => {
            const timer2 = setTimeout(resolve2, FLUSH_TIMEOUT_MS);
            timer2.unref();
            flushed = () => {
              clearTimeout(timer2);
              resolve2();
            };
          });
        } catch {
        }
      }
      teardown();
      return assembler.text();
    },
    abort: teardown
  };
}
let modelCache = null;
async function listStreamingModels(apiKey) {
  if (modelCache?.key === apiKey) return modelCache.models;
  const client = new DeepgramClient({ apiKey });
  const response = await client.manage.v1.models.list();
  const byId = /* @__PURE__ */ new Map();
  for (const model of response.stt ?? []) {
    const id = model.canonical_name;
    if (!model.streaming || !id) continue;
    const existing = byId.get(id);
    byId.set(id, {
      id,
      // The canonical name is the label, not `name`. `name` is a display
      // fragment — Deepgram returns "2-automotive" for what it calls
      // nova-2-automotive — which is ambiguous on its own and unsearchable by
      // the word a user would actually type.
      label: id,
      // Versions can differ in coverage; the union is what the model supports.
      languages: [
        .../* @__PURE__ */ new Set([...existing?.languages ?? [], ...model.languages ?? []])
      ].sort()
    });
  }
  const models = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  modelCache = { key: apiKey, models };
  return models;
}
async function verifyKey(apiKey) {
  try {
    await new DeepgramClient({ apiKey }).manage.v1.models.list();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /401|unauthor|forbidden|invalid/i.test(message) ? "Deepgram rejected that key." : `Could not reach Deepgram: ${message}`;
  }
}
async function transcribeWav(apiKey, wav, options) {
  const client = new DeepgramClient({ apiKey });
  const response = await client.listen.v1.media.transcribeFile(wav, {
    model: options.model,
    language: options.language,
    // Batch takes real booleans; only the WebSocket params are stringly-typed.
    smart_format: true,
    punctuate: true,
    paragraphs: true
  });
  if (!("results" in response)) return "";
  const alternative = response.results.channels[0]?.alternatives?.[0];
  return (alternative?.paragraphs?.transcript ?? alternative?.transcript ?? "").trim();
}
const BYTES_PER_SAMPLE = 2;
const CHUNK_SECONDS = 5 * 60;
const CHUNK_BYTES = CHUNK_SECONDS * STREAM_SAMPLE_RATE * BYTES_PER_SAMPLE;
const recordingsDir = () => join(app.getPath("userData"), "recordings");
const pcmPath = (id) => join(recordingsDir(), `${id}.pcm`);
const metaPath = (id) => join(recordingsDir(), `${id}.json`);
function durationOf(bytes) {
  return bytes / BYTES_PER_SAMPLE / STREAM_SAMPLE_RATE / STREAM_CHANNELS;
}
function startRecording(meta) {
  const id = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  mkdirSync(recordingsDir(), { recursive: true });
  writeFileSync(
    metaPath(id),
    JSON.stringify({ ...meta, id, startedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)
  );
  let fd = openSync(pcmPath(id), "w");
  let written = 0;
  const close = () => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
    }
    fd = null;
  };
  const remove = () => {
    close();
    for (const path of [pcmPath(id), metaPath(id)]) {
      try {
        if (existsSync(path)) rmSync(path);
      } catch {
      }
    }
  };
  return {
    id,
    write(chunk) {
      if (fd === null) return;
      try {
        writeSync(fd, chunk);
        written += chunk.length;
      } catch {
        close();
      }
    },
    bytes: () => written,
    discard: remove,
    keep() {
      close();
      if (written === 0) remove();
    }
  };
}
function pendingRecordings() {
  const dir = recordingsDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!existsSync(pcmPath(id))) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath(id), "utf8"));
      const bytes = statSync(pcmPath(id)).size;
      if (bytes === 0) continue;
      out.push({ ...meta, id, bytes, durationS: durationOf(bytes) });
    } catch {
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
function discardRecording(id) {
  for (const path of [pcmPath(id), metaPath(id)]) {
    try {
      if (existsSync(path)) rmSync(path);
    } catch {
    }
  }
}
function wavHeader(pcmBytes) {
  const header = Buffer.alloc(44);
  const byteRate = STREAM_SAMPLE_RATE * STREAM_CHANNELS * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(STREAM_CHANNELS, 22);
  header.writeUInt32LE(STREAM_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(STREAM_CHANNELS * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}
async function recoverRecording(id, apiKey, onProgress) {
  if (!existsSync(pcmPath(id)) || !existsSync(metaPath(id)))
    return { ok: false, error: "That recording is no longer on disk." };
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath(id), "utf8"));
  } catch {
    return { ok: false, error: "That recording’s details could not be read." };
  }
  const total = statSync(pcmPath(id)).size;
  const chunks = Math.max(1, Math.ceil(total / CHUNK_BYTES));
  const parts = [];
  const fd = openSync(pcmPath(id), "r");
  try {
    for (let index = 0; index < chunks; index++) {
      const offset = index * CHUNK_BYTES;
      const length = Math.min(CHUNK_BYTES, total - offset);
      const aligned = length - length % BYTES_PER_SAMPLE;
      if (aligned <= 0) continue;
      const pcm = Buffer.alloc(aligned);
      readSync(fd, pcm, 0, aligned, offset);
      const text = await transcribeWav(apiKey, Buffer.concat([wavHeader(aligned), pcm]), {
        model: meta.model,
        language: meta.language
      });
      if (text) parts.push(text);
      onProgress?.(index + 1, chunks);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return parts.length ? { ok: true, transcript: parts.join("\n\n"), durationS: durationOf(total), meta } : { ok: false, error: `Deepgram rejected the recovery: ${message}` };
  } finally {
    closeSync(fd);
  }
  return { ok: true, transcript: parts.join("\n\n"), durationS: durationOf(total), meta };
}
const AUDIO_QUIET_MS = 100;
const AUDIO_DRAIN_CAP_MS = 1e3;
let proc = null;
let owner = null;
let sink = null;
let stream = null;
let recording = null;
let lastAudioAt = 0;
let broadcast = () => {
};
function setSttBroadcast(fn) {
  broadcast = fn;
}
function sidecarPath() {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, "bin", "chewo-audio-capture");
    return existsSync(packaged) ? packaged : null;
  }
  for (const config of ["release", "debug"]) {
    const built = join(
      app.getAppPath(),
      "packages",
      "audio-capture",
      ".build",
      config,
      "chewo-audio-capture"
    );
    if (existsSync(built)) return built;
  }
  return null;
}
function emit$1(ev) {
  if (sink) sink(owner ? { ...ev, owner } : ev);
  else broadcast(ev);
}
function release(keepAudio) {
  if (recording) {
    if (keepAudio) recording.keep();
    else recording.discard();
    recording = null;
  }
  stream = null;
  owner = null;
  sink = null;
}
function ensureSidecar() {
  if (proc && proc.exitCode === null) return proc;
  const bin = sidecarPath();
  if (!bin) return null;
  const child2 = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  let buffer = "";
  child2.stdout?.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleSidecarEvent(JSON.parse(line));
      } catch {
      }
    }
  });
  const audio = child2.stdio[3];
  audio?.on("data", (chunk) => {
    lastAudioAt = Date.now();
    recording?.write(chunk);
    stream?.send(chunk);
  });
  child2.stderr?.on("data", () => {
  });
  child2.on("error", (err) => {
    if (proc === child2) proc = null;
    fail(`Audio capture failed: ${err.message}`);
  });
  child2.on("exit", (code) => {
    if (proc === child2) proc = null;
    if (code !== 0 && code !== null) fail(`Audio capture exited (code ${code})`);
  });
  proc = child2;
  return child2;
}
function fail(message) {
  if (!owner) {
    broadcast({ event: "error", message });
    return;
  }
  const hadAudio = (recording?.bytes() ?? 0) > 0;
  stream?.abort();
  emit$1({
    event: "error",
    message: hadAudio ? `${message} — the audio was saved, recover it in Settings → Voice.` : message
  });
  release(true);
}
function handleSidecarEvent(ev) {
  switch (ev.event) {
    case "ready":
      emit$1({ event: "ready" });
      break;
    case "level":
      emit$1(ev);
      break;
    case "stopped":
      void finalize();
      break;
    case "error":
      fail(ev.message ?? "Audio capture error");
      break;
  }
}
async function drainAudio() {
  const deadline = Date.now() + AUDIO_DRAIN_CAP_MS;
  while (Date.now() < deadline && Date.now() - lastAudioAt < AUDIO_QUIET_MS) {
    await new Promise((resolve2) => setTimeout(resolve2, 25));
  }
}
async function finalize() {
  if (!owner) return;
  const active = stream;
  const handle = recording;
  if (!active) {
    emit$1({ event: "final", text: "", duration_s: 0 });
    release(false);
    return;
  }
  await drainAudio();
  const durationS = durationOf(handle?.bytes() ?? 0);
  let text;
  try {
    text = await active.finish();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  emit$1({ event: "final", text, duration_s: durationS });
  release(text === "" && durationS > 2);
}
const send = (child2, cmd) => {
  try {
    child2.stdin?.write(JSON.stringify(cmd) + "\n");
  } catch {
  }
};
const BUSY = {
  notes: "Mic is busy — a notes recording is running.",
  todo: "Mic is busy — a voice command is running.",
  chat: "Mic is busy — a chat is being dictated into."
};
const NO_KEY = "Add a Deepgram API key in Settings → Voice to turn on dictation.";
const NO_SIDECAR = "Audio capture isn’t built — run: npm run build:stt";
function sttStart(who, eventSink, source = "mic", context = {}) {
  if (owner && owner !== who) return BUSY[owner];
  const key = deepgramKey();
  if (!key) return NO_KEY;
  const child2 = ensureSidecar();
  if (!child2) return NO_SIDECAR;
  owner = who;
  sink = eventSink;
  emit$1({ event: "connecting" });
  const stt = normalizeStt(loadSettings().stt);
  void openDeepgramStream({
    apiKey: key,
    model: stt.model,
    language: stt.language,
    keyterms: stt.keyterms,
    onPartial: ({ confirmed, tail }) => emit$1({ event: "partial", confirmed, tail }),
    onError: (message) => fail(`Deepgram: ${message}`)
  }).then((opened) => {
    if (owner !== who) {
      opened.abort();
      return;
    }
    stream = opened;
    recording = startRecording({
      lessonPath: context.lessonPath,
      style: context.style,
      model: stt.model,
      language: stt.language
    });
    lastAudioAt = Date.now();
    send(child2, { cmd: "start", source });
  }).catch((error) => {
    if (owner !== who) return;
    const message = error instanceof Error ? error.message : String(error);
    emit$1({ event: "error", message: `Could not reach Deepgram: ${message}` });
    release(false);
  });
  return null;
}
function sttStop() {
  if (!owner) return;
  if (recording) {
    if (proc) send(proc, { cmd: "stop" });
    else void finalize();
    return;
  }
  stream?.abort();
  emit$1({ event: "final", text: "", duration_s: 0 });
  release(false);
}
function sttOwner() {
  return owner;
}
function disposeSidecar() {
  stream?.abort();
  recording?.keep();
  recording = null;
  stream = null;
  owner = null;
  sink = null;
  if (!proc) return;
  const child2 = proc;
  proc = null;
  send(child2, { cmd: "shutdown" });
  setTimeout(() => {
    try {
      child2.kill();
    } catch {
    }
  }, 1500).unref();
}
const LEGACY_MODELS_DIR = join(homedir(), ".chewo", "models");
function legacyModelsDir() {
  return LEGACY_MODELS_DIR;
}
function legacyModelsBytes() {
  if (!existsSync(LEGACY_MODELS_DIR)) return 0;
  let total = 0;
  const walk = (path) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  };
  walk(LEGACY_MODELS_DIR);
  return total;
}
function removeLegacyModels() {
  try {
    rmSync(LEGACY_MODELS_DIR, { recursive: true, force: true });
  } catch {
  }
}
const COMMAND_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    commands: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "move", "edit", "delete", "none"] },
          scope: { type: "string" },
          cardId: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          to: { type: ["string", "null"] }
        },
        required: ["action", "scope"]
      }
    }
  },
  required: ["commands"]
});
const buildPrompt = (transcript, scopes) => `You interpret a dictated command for a kanban todo app and return only the structured commands.

Boards ("scopes") and their current cards:
${JSON.stringify({ scopes })}

Utterance (may begin with the wake word "che-wo" — ignore it): ${JSON.stringify(transcript)}

Rules: return the commands to perform, in utterance order — usually one, several when the utterance asks for several things ("delete A and B" → two delete commands; "the rest of the todos" → one command per matching card). "add" needs scope + title (concise imperative title; put extra detail in "text"). "move" needs cardId + to (one of ${JSON.stringify(TODO_STATUSES)}; fuzzy-match the card by title — dictation garbles words). "edit" needs cardId plus the new title and/or text. "delete" needs cardId. Use the scope whose project name the utterance mentions (fuzzy-match); otherwise scope "${GENERAL_SCOPE}". If intent is unclear or nothing matches, return exactly one command with action "none" and the reason in "text" — never mix "none" with real commands.`;
function parseInterpreterOutput(structured) {
  if (!structured || typeof structured !== "object")
    throw new Error("Interpreter returned unparseable output.");
  const commands = structured.commands;
  if (Array.isArray(commands)) return commands;
  if ("action" in structured) return [structured];
  throw new Error(`Interpreter gave no command: ${JSON.stringify(structured).slice(0, 120)}`);
}
const DEFAULT_TODO_HOTKEY = "Command+.";
const HUD_WIDTH = 460;
const HUD_HEIGHT = 176;
const HUD_MIN_HEIGHT = 120;
const HUD_MAX_HEIGHT = 480;
const INTERPRET_TIMEOUT_MS = 6e4;
let mainWin = null;
let hud = null;
let phase = "idle";
let registeredHotkey = null;
let hideTimer = null;
let undoState = null;
function ensureHud() {
  if (hud && !hud.isDestroyed()) return hud;
  hud = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    // Never steal focus — dictation happens over whatever app is frontmost
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  hud.setAlwaysOnTop(true, "screen-saver");
  hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void hud.loadURL(process.env["ELECTRON_RENDERER_URL"] + "/hud.html");
  } else {
    void hud.loadFile(join(__dirname, "../renderer/hud.html"));
  }
  return hud;
}
function showHud() {
  const win = ensureHud();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  win.setPosition(Math.round(x + (width - HUD_WIDTH) / 2), y + 48);
  if (!win.isVisible()) win.showInactive();
}
function pushHud(state) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  safeSend(hud, "hud:state", state);
}
function hideHudAfter(ms) {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    phase = "idle";
    hud?.hide();
  }, ms);
}
function closeHud() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
  if (hud && !hud.isDestroyed()) hud.close();
  hud = null;
}
function onHotkey() {
  if (phase === "capturing") {
    phase = "thinking";
    pushHud({ phase: "thinking" });
    sttStop();
    return;
  }
  if (phase === "thinking") return;
  if (sttOwner() === "notes") {
    sttStop();
    return;
  }
  startCapture();
}
function startCapture() {
  showHud();
  const err = sttStart("todo", onSttEvent);
  if (err) {
    phase = "idle";
    pushHud({ phase: "error", message: err });
    hideHudAfter(4e3);
    return;
  }
  phase = "capturing";
  pushHud({ phase: "capturing", confirmed: "", tail: "", level: 0, loading: true });
}
function onSttEvent(ev) {
  switch (ev.event) {
    case "connecting":
      pushHud({ phase: "capturing", loading: true });
      break;
    case "ready":
      if (phase === "capturing") pushHud({ phase: "capturing", loading: false });
      break;
    case "level":
      if (phase === "capturing") pushHud({ phase: "capturing", level: ev.rms ?? 0 });
      break;
    case "partial":
      if (phase === "capturing")
        pushHud({
          phase: "capturing",
          confirmed: ev.confirmed ?? "",
          tail: ev.tail ?? "",
          loading: false
        });
      break;
    case "final":
      phase = "thinking";
      pushHud({ phase: "thinking", finalText: (ev.text ?? "").trim() });
      void handleFinal(ev.text ?? "");
      break;
    case "error":
      phase = "idle";
      pushHud({ phase: "error", message: ev.message ?? "Dictation failed" });
      hideHudAfter(4e3);
      break;
  }
}
async function handleFinal(text) {
  const transcript = text.trim();
  if (!transcript) {
    phase = "idle";
    pushHud({ phase: "error", message: "No speech captured." });
    hideHudAfter(2500);
    return;
  }
  try {
    const scopes = boardSnapshot();
    const commands = await interpret(transcript, scopes);
    const outcome = executeAll(commands, scopes);
    phase = "result";
    pushHud({
      phase: "result",
      summary: outcome.summary,
      undoable: outcome.undoable,
      finalText: transcript
    });
    hideHudAfter(outcome.undoable ? 1e4 : 7e3);
  } catch (err) {
    phase = "idle";
    pushHud({
      phase: "error",
      message: err instanceof Error ? err.message : String(err),
      finalText: transcript
    });
    hideHudAfter(7e3);
  }
}
function boardSnapshot() {
  const file = loadProjects();
  const scopes = [
    { scope: GENERAL_SCOPE, name: "General" },
    ...file.projects.map((p) => ({ scope: projectScopeDir(p.name, p.path), name: p.name }))
  ];
  return scopes.map(({ scope, name }) => {
    const board = loadBoard(scope);
    const cards = [];
    for (const column of TODO_STATUSES) {
      for (const id of board.columns[column]) {
        const card = board.cards[id];
        if (card) cards.push({ id, title: card.title.slice(0, 80), column });
      }
    }
    return { scope, name, cards };
  });
}
async function interpret(transcript, scopes) {
  const structured = await runAgentJson({
    choice: agentFor("todoVoice"),
    // cwd pins the session under ~/.chewo so the coding sidebar filters it
    cwd: todosRootPath(),
    prompt: buildPrompt(transcript, scopes),
    schema: COMMAND_SCHEMA,
    timeoutMs: INTERPRET_TIMEOUT_MS,
    label: "Interpreter"
  });
  return parseInterpreterOutput(structured);
}
function executeAll(commands, scopes) {
  const snapshots = /* @__PURE__ */ new Map();
  const lines = [];
  let mutated = false;
  for (const command of commands) {
    try {
      const line = executeOne(command, scopes, snapshots);
      lines.push(line.summary);
      mutated = mutated || line.mutated;
    } catch (err) {
      lines.push(`✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  undoState = mutated ? snapshots : null;
  return {
    summary: lines.join("\n") || "Could not understand that.",
    undoable: mutated
  };
}
function executeOne(command, scopes, snapshots) {
  if (command.action === "none")
    return { summary: command.text?.trim() || "Could not understand that.", mutated: false };
  const scope = scopes.find((s) => s.scope === command.scope);
  if (!scope) throw new Error(`Unknown board “${command.scope}”.`);
  const ensureSnapshot = () => {
    let snap = snapshots.get(scope.scope);
    if (!snap) {
      snap = { board: loadBoard(scope.scope), assets: [] };
      snapshots.set(scope.scope, snap);
    }
    return snap;
  };
  switch (command.action) {
    case "add": {
      const title = command.title?.trim();
      if (!title) throw new Error("No title for the new todo.");
      ensureSnapshot();
      addCard(scope.scope, title, "todo", command.text ?? void 0);
      return { summary: `Added “${title}” to ${scope.name} → Todo`, mutated: true };
    }
    case "move": {
      const board = loadBoard(scope.scope);
      const card = command.cardId ? board.cards[command.cardId] : void 0;
      if (!card) throw new Error("That card no longer exists.");
      const to = command.to;
      if (!TODO_STATUSES.includes(to)) throw new Error(`Unknown column “${command.to}”.`);
      if (statusOf(board, card.id) === to)
        return { summary: `“${card.title}” is already in ${TODO_STATUS_LABELS[to]}.`, mutated: false };
      ensureSnapshot();
      moveCard(scope.scope, card.id, to);
      return { summary: `Moved “${card.title}” to ${TODO_STATUS_LABELS[to]}`, mutated: true };
    }
    case "edit": {
      const board = loadBoard(scope.scope);
      const card = command.cardId ? board.cards[command.cardId] : void 0;
      if (!card) throw new Error("That card no longer exists.");
      ensureSnapshot();
      updateCard({
        scopeDir: scope.scope,
        cardId: card.id,
        title: command.title?.trim() || card.title,
        text: command.text ?? card.text ?? "",
        addImages: [],
        removeImages: []
      });
      return { summary: `Updated “${card.title}”`, mutated: true };
    }
    case "delete": {
      const board = loadBoard(scope.scope);
      const card = command.cardId ? board.cards[command.cardId] : void 0;
      if (!card) throw new Error("That card no longer exists.");
      const snap = ensureSnapshot();
      for (const name of card.images ?? []) {
        const dataUrl = readAsset(scope.scope, name);
        if (dataUrl) snap.assets.push({ name, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      }
      deleteCard(scope.scope, card.id);
      return { summary: `Deleted “${card.title}”`, mutated: true };
    }
  }
}
function undo() {
  if (!undoState) return;
  for (const [scopeDir, snap] of undoState) {
    restoreAssets(scopeDir, snap.assets);
    restoreBoard(scopeDir, snap.board);
  }
  undoState = null;
  phase = "result";
  pushHud({ phase: "result", summary: "Undone", undoable: false });
  hideHudAfter(1500);
}
function updateTodoHotkey(accelerator) {
  const accel = accelerator?.trim() || DEFAULT_TODO_HOTKEY;
  if (accel === registeredHotkey) return null;
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
  let ok = false;
  try {
    ok = globalShortcut.register(accel, onHotkey);
  } catch {
    ok = false;
  }
  if (!ok) return `Could not register the voice hotkey “${accel}” — it may be taken by another app.`;
  registeredHotkey = accel;
  return null;
}
function initTodoVoice(win, hotkey) {
  mainWin = win;
  ipcMain.on("hud:action", (_e, action) => {
    if (action === "stop" && phase === "capturing") onHotkey();
    else if (action === "undo") undo();
    else if (action === "dismiss") {
      phase = "idle";
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      hud?.hide();
    } else if (action === "hover-in") {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
    } else if (action === "hover-out") {
      if (phase === "result" || phase === "idle") hideHudAfter(2500);
    }
  });
  ipcMain.on("hud:resize", (_e, height) => {
    if (!hud || hud.isDestroyed() || typeof height !== "number") return;
    const clamped = Math.round(Math.min(HUD_MAX_HEIGHT, Math.max(HUD_MIN_HEIGHT, height)));
    const [x, y] = hud.getPosition();
    hud.setBounds({ x, y, width: HUD_WIDTH, height: clamped });
  });
  const err = updateTodoHotkey(hotkey);
  if (err) safeSend(mainWin, "app:toast", err);
}
function disposeTodoVoice() {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
  registeredHotkey = null;
  closeHud();
}
const STRUCTURE_TIMEOUT_MS = 5 * 60 * 1e3;
const PROMPT = (existingBody, transcript) => `You are extending a student's lesson note with newly dictated lecture material.

CURRENT NOTE (markdown, may be empty):
<<<
${existingBody}
>>>

NEW RAW TRANSCRIPT (speech-to-text of the latest recording):
<<<
${transcript}
>>>

Structure the new transcript into markdown that CONTINUES the current note:
- "## " sections grouping the new material by theme, in the order it was taught
- bullet the key points; put key terms in **bold** followed by their definition
- keep the speaker's examples; be faithful to the transcript; never invent content
- do not repeat or rewrite material already in the current note
- no overall summary section, no preamble, no code fences

Output ONLY the new markdown to append.`;
const MEETING_PROMPT = (existingBody, transcript) => `You are extending a meeting note with the transcript of a newly recorded discussion.

CURRENT NOTE (markdown, may be empty):
<<<
${existingBody}
>>>

NEW RAW TRANSCRIPT (speech-to-text of the latest recording; speakers are not labeled):
<<<
${transcript}
>>>

Structure the new transcript into markdown that CONTINUES the current note:
- "## " sections grouping the discussion by topic, in the order it happened
- bullet the key points; keep who-said-what only when the transcript makes it clear — never guess speakers
- if decisions were made, end with a "## Decisions" section listing each one
- if tasks or follow-ups were agreed, end with a "## Action items" section (checkbox bullets "- [ ] ...", with owner if stated)
- omit the Decisions / Action items sections when the transcript has none; be faithful to the transcript; never invent content
- do not repeat or rewrite material already in the current note
- no overall summary section, no preamble, no code fences

Output ONLY the new markdown to append.`;
function assertLessonInsideRoot(path) {
  const resolved = resolve(path);
  const root2 = resolve(getNotesRoot());
  if (!resolved.startsWith(root2 + sep) || !resolved.endsWith(".md"))
    throw new Error(`not a lesson inside the notes root: ${path}`);
  return resolved;
}
async function structureTranscript(args) {
  try {
    const lessonPath = assertLessonInsideRoot(args.lessonPath);
    const lessonContent = readFileSync(lessonPath, "utf8");
    const existingBody = parseNote(lessonContent).body;
    const rawPath = lessonPath.replace(/\.md$/, ".raw.md");
    const stamp = `*${(/* @__PURE__ */ new Date()).toISOString()} — ${Math.round(args.durationS)}s, ${args.sttModel}*`;
    const rawChunk = `

---

${stamp}

${args.transcript}
`;
    if (existsSync(rawPath)) {
      appendFileSync(rawPath, rawChunk);
    } else {
      writeFileSync(
        rawPath,
        `---
title: ${basename(lessonPath, ".md")} (raw transcripts)
status: raw
---
${rawChunk}`
      );
    }
    const cwd = resolve(lessonPath, "..");
    const prompt = args.style === "meeting" ? MEETING_PROMPT : PROMPT;
    const body = await runAgentText({
      choice: agentFor("notesStructure"),
      cwd,
      prompt: prompt(existingBody, args.transcript),
      timeoutMs: STRUCTURE_TIMEOUT_MS,
      label: "Structuring"
    });
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
}
async function readStatus(cwd) {
  const res = await runGit(cwd, ["status", "--porcelain=v1", "-z", "-unormal"]);
  if (!res.ok) return gitErrorOf(res);
  const out = /* @__PURE__ */ new Map();
  const parts = res.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const path = rec.slice(3);
    if (x === "R" || x === "C") i++;
    if (x === "?" && y === "?") out.set(path, "untracked");
    else if (x === "A") out.set(path, "added");
    else out.set(path, "tracked");
  }
  return out;
}
async function discardChanges(root2, paths) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return { ok: false, discarded: [], skipped: [], error: `not readable: ${basename(root2)}` };
  if (paths.length === 0) return { ok: true, discarded: [], skipped: [] };
  if (!paths.every(safePathspec))
    return { ok: false, discarded: [], skipped: [], error: "invalid path" };
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok)
    return { ok: false, discarded: [], skipped: [], error: `${basename(root2)} is not a git repository` };
  const status = await readStatus(cwd);
  if (typeof status === "string") return { ok: false, discarded: [], skipped: [], error: status };
  const collapsed = [...status.keys()].filter((p) => p.endsWith("/"));
  const untracked = [];
  const added = [];
  const tracked = [];
  const skipped = [];
  for (const path of paths) {
    const kind = status.get(path) ?? (path.endsWith("/") || collapsed.some((d) => path.startsWith(d)) ? "untracked" : void 0);
    if (kind === "untracked") untracked.push(path);
    else if (kind === "added") added.push(path);
    else if (kind === "tracked") tracked.push(path);
    else skipped.push(path);
  }
  const discarded = [];
  const fail2 = (msg) => ({ ok: false, discarded, skipped, error: msg });
  if (tracked.length > 0) {
    const res = await runGit(cwd, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...tracked
    ]);
    if (!res.ok) return fail2(gitErrorOf(res));
    discarded.push(...tracked);
  }
  if (added.length > 0) {
    const unstage = await runGit(cwd, ["restore", "--staged", "--", ...added]);
    if (!unstage.ok) return fail2(gitErrorOf(unstage));
    untracked.push(...added);
  }
  if (untracked.length > 0) {
    const res = await runGit(cwd, ["clean", "-f", "-d", "--", ...untracked]);
    if (!res.ok) return fail2(gitErrorOf(res));
    discarded.push(...untracked);
  }
  return { ok: true, discarded, skipped };
}
const STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "be",
  "can",
  "you",
  "please",
  "i",
  "we",
  "it",
  "this",
  "that",
  "my",
  "our",
  "lets",
  "let",
  "let's"
]);
const MAX_CHARS = 48;
function slugifyBranch(text, maxWords = 5) {
  const words = text.toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  const picked = (meaningful.length ? meaningful : words).slice(0, maxWords);
  const kept = [];
  let len = 0;
  for (const word of picked) {
    const next2 = kept.length ? len + 1 + word.length : word.length;
    if (kept.length && next2 > MAX_CHARS) break;
    kept.push(word);
    len = next2;
  }
  return kept.join("-").slice(0, MAX_CHARS);
}
function uniqueBranchName(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}
function willCutBranch(route, branch, base, repoDefault) {
  if (route === "push") return branch !== base && branch === repoDefault;
  return branch === base || branch === repoDefault;
}
const TIMEOUT_MS = 9e4;
const FAST_TEXT = { agent: "claude", model: "opus", effort: "medium" };
const MAX_DIFF_CHARS = 48e3;
const MAX_STAT_CHARS = 12e3;
function neutralCwd() {
  const dir = join(homedir(), ".chewo", "git-text");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function textChoice() {
  const choice2 = agentFor("gitText");
  if (choice2.agent !== FAST_TEXT.agent) return choice2;
  return {
    ...choice2,
    model: choice2.model || FAST_TEXT.model,
    effort: choice2.effort || FAST_TEXT.effort
  };
}
async function ask(label, prompt, schema, read) {
  try {
    const raw = await runAgentJson({
      choice: textChoice(),
      cwd: neutralCwd(),
      prompt,
      schema,
      timeoutMs: TIMEOUT_MS,
      label
    });
    if (!raw || typeof raw !== "object") return null;
    return read(raw);
  } catch {
    return null;
  }
}
const str = (v) => typeof v === "string" ? v.trim() : "";
function budgetDiff(diff, max) {
  if (diff.length <= max) return diff;
  const parts = diff.split(/\n(?=diff --git )/);
  if (parts.length < 2) return `${diff.slice(0, max)}
… diff truncated`;
  const shares = new Array(parts.length).fill(0);
  let pool = max;
  let open = parts.map((_, i) => i);
  while (open.length > 0) {
    const share = Math.floor(pool / open.length);
    if (share <= 0) break;
    const fits = open.filter((i) => parts[i].length <= share);
    if (fits.length === 0) {
      for (const i of open) shares[i] = share;
      break;
    }
    for (const i of fits) {
      shares[i] = parts[i].length;
      pool -= parts[i].length;
    }
    open = open.filter((i) => parts[i].length > share);
  }
  return parts.map((part, i) => {
    if (part.length <= shares[i]) return part;
    const dropped = part.slice(shares[i]).split("\n").length;
    const notice = `… ${dropped} more lines of this file's diff not shown`;
    const kept = part.slice(0, Math.max(0, shares[i] - notice.length - 1));
    const end = kept.lastIndexOf("\n");
    return `${end > 0 ? kept.slice(0, end + 1) : kept}${notice}`;
  }).join("\n");
}
const STRUCTURAL = /^(\s{4,}|\t|[-*+]\s|\d+[.)]\s|>|#{1,6}\s|```)/;
function unwrapBody(text) {
  return text.split(/\n\s*\n/).map((block) => {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.some((l) => STRUCTURAL.test(l))) return lines.join("\n");
    return lines.map((l) => l.trim()).filter(Boolean).join(" ");
  }).filter(Boolean).join("\n\n");
}
const COMMIT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    subject: {
      type: "string",
      description: "Conventional-commit subject line, max 72 chars, imperative mood"
    },
    body: {
      type: ["string", "null"],
      description: "Optional body explaining why, as unwrapped paragraphs separated by blank lines. Empty when the subject says it all."
    }
  },
  required: ["subject"]
});
async function suggestCommitMessage(diffStat, diffText, fileCount) {
  const fallback = {
    subject: `chore: update ${fileCount} ${fileCount === 1 ? "file" : "files"}`,
    body: ""
  };
  const answer = await ask("Commit message", commitPrompt(diffStat, diffText), COMMIT_SCHEMA, (o) => {
    const subject = str(o.subject);
    return subject ? { subject: subject.split("\n")[0].slice(0, 72), body: unwrapBody(str(o.body)) } : null;
  });
  return answer ?? fallback;
}
function commitPrompt(diffStat, diffText) {
  return [
    "Write a commit message for this staged change. Reply only through the schema.",
    "",
    "Subject: conventional commits (feat/fix/refactor/chore/docs/test/perf),",
    "imperative mood, max 72 characters, no trailing period.",
    "Body: only if the subject leaves something worth saying — say why, not what.",
    "Write it as whole paragraphs separated by blank lines. Do not hard-wrap",
    "lines at 72 columns or any other width — it is edited in a text box, not vi.",
    "Do not mention being an AI, and do not add a trailer or signature.",
    "",
    "--- diffstat ---",
    diffStat.slice(0, MAX_STAT_CHARS),
    "",
    "--- diff (long files are truncated; every changed file is represented) ---",
    budgetDiff(diffText, MAX_DIFF_CHARS)
  ].join("\n");
}
const PR_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string", description: "PR title, max 72 chars" },
    body: { type: ["string", "null"], description: "PR description in markdown" }
  },
  required: ["title"]
});
async function suggestPrText(branch, commits, diffStat) {
  const fallback = {
    title: commits.length === 1 ? stripHash(commits[0]) : `${branch}: ${commits.length} commits`,
    body: commits.length ? commits.map((c) => `- ${stripHash(c)}`).join("\n") : ""
  };
  const answer = await ask("PR text", prPrompt(commits, diffStat), PR_SCHEMA, (o) => {
    const title = str(o.title);
    return title ? { title: title.split("\n")[0].slice(0, 72), body: str(o.body) } : null;
  });
  return answer ?? fallback;
}
const stripHash = (line) => line.replace(/^[0-9a-f]{7,40}\s+/i, "");
function prPrompt(commits, diffStat) {
  return [
    "Write a pull request title and description for this branch.",
    "Reply only through the schema.",
    "",
    "Title: max 72 characters, imperative, no conventional-commit prefix needed.",
    "Body: markdown. Lead with one paragraph on what changed and why, then a",
    "short bullet list if there is more than one distinct change. No headings",
    "unless the change is genuinely large. Do not mention being an AI, and do",
    "not add a trailer or signature.",
    "",
    "--- commits ---",
    commits.slice(0, 100).join("\n"),
    "",
    "--- diffstat ---",
    diffStat.slice(0, MAX_STAT_CHARS)
  ].join("\n");
}
const NETWORK_TIMEOUT_MS = 12e4;
let ghPath;
function shellLookup(bin) {
  return new Promise((resolve2) => {
    execFile(
      "/bin/zsh",
      ["-ilc", `command -v ${bin}`],
      { timeout: 15e3, env: buildPtyEnv(process.env) },
      (err, stdout) => resolve2(err ? null : String(stdout).trim() || null)
    );
  });
}
async function runGh(cwd, args, timeoutMs = 6e4) {
  if (ghPath === void 0) ghPath = await shellLookup("gh");
  if (!ghPath) return { ok: false, stdout: "", stderr: "gh-not-found" };
  return new Promise((resolve2) => {
    execFile(
      ghPath,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: buildPtyEnv(process.env) },
      (err, stdout, stderr) => resolve2({ ok: !err, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}
const ghErrorOf = (r) => r.stderr.trim() || r.stdout.trim() || "gh failed";
const NOT_INSTALLED = "GitHub CLI (gh) isn’t installed — `brew install gh`, then `gh auth login`.";
const NOT_AUTHED = "GitHub CLI isn’t signed in — run `gh auth login` in a terminal.";
async function ghReady(cwd) {
  const auth = await runGh(cwd, ["auth", "status"]);
  if (auth.ok) return null;
  return auth.stderr === "gh-not-found" ? NOT_INSTALLED : NOT_AUTHED;
}
async function defaultBranch(cwd) {
  const res = await runGh(cwd, ["repo", "view", "--json", "defaultBranchRef"]);
  if (!res.ok) return "main";
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed.defaultBranchRef?.name || "main";
  } catch {
    return "main";
  }
}
async function localBranches(cwd) {
  const res = await runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return res.ok ? res.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}
async function remoteBases(cwd) {
  const res = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)",
    "--sort=-committerdate",
    "refs/remotes"
  ]);
  if (!res.ok) return [];
  const names = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean).filter((n) => !n.endsWith("/HEAD")).map((n) => n.slice(n.indexOf("/") + 1));
  return [...new Set(names)];
}
async function isPushed(cwd, branch) {
  const remote = await pushRemote(cwd);
  const res = await runGit(cwd, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/${remote}/${branch}`
  ]);
  return res.ok;
}
async function invalidBranchName(cwd, name) {
  if (!name.trim()) return "Branch name is required";
  if (name.startsWith("-") || name.includes("@{"))
    return `Not a valid branch name: ${name}`;
  const res = await runGit(cwd, ["check-ref-format", "--branch", name]);
  return res.ok ? null : `Not a valid branch name: ${name}`;
}
async function comparisonRef(cwd, base) {
  const remote = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`]);
  return remote.ok ? `origin/${base}` : base;
}
async function resolveBase(cwd, raw, repoDefault) {
  const base = raw?.trim();
  if (!base) return repoDefault;
  const slash = base.indexOf("/");
  const tracking = slash > 0 && (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${base}`])).ok;
  const name = tracking ? base.slice(slash + 1) : base;
  const remote = await pushRemote(cwd);
  const onRemote = await runGit(cwd, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/${remote}/${name}`
  ]);
  return onRemote.ok ? name : repoDefault;
}
async function shipPreview(args) {
  const cwd = resolveInsideRoots(args.root);
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` };
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: `${basename(args.root)} is not a git repository` };
  const headCommit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!headCommit.ok)
    return { ok: false, error: "This repository has no commits yet — make one first." };
  const notReady = await ghReady(cwd);
  if (notReady) return { ok: false, error: notReady };
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.stdout.trim();
  if (!head.ok || branch === "HEAD")
    return { ok: false, error: "Detached HEAD — check out a branch before shipping." };
  const [repoDefault, existingPr, status, remotes, pushed] = await Promise.all([
    defaultBranch(cwd),
    openPrUrl(cwd, branch),
    runGit(cwd, ["status", "--porcelain", "-uall"]),
    remoteBases(cwd),
    isPushed(cwd, branch)
  ]);
  const base = await resolveBase(cwd, args.base, repoDefault);
  const bases = [.../* @__PURE__ */ new Set([base, repoDefault, ...remotes])].filter((b) => b !== branch);
  const compare = await comparisonRef(cwd, base);
  const willBranch = branch === base || branch === repoDefault;
  const files = status.stdout.split("\n").filter((l) => l.trim()).map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).trim() }));
  const log = await runGit(cwd, ["log", "--oneline", `${compare}..HEAD`]);
  const commits = log.ok ? log.stdout.split("\n").filter(Boolean) : [];
  const nothingToDo = files.length === 0 && commits.length === 0;
  if (nothingToDo)
    return {
      ok: true,
      branch,
      base,
      repoDefault,
      bases,
      pushed,
      willBranch: false,
      files,
      commits,
      subject: "",
      body: "",
      prTitle: "",
      prBody: "",
      existingPr,
      nothingToDo
    };
  const [stat, text, diffStat] = await Promise.all([
    runGit(cwd, ["diff", "--stat", "HEAD"]),
    runGit(cwd, ["diff", "HEAD"]),
    runGit(cwd, ["diff", "--stat", `${compare}...HEAD`])
  ]);
  const untracked = files.filter((f) => f.status === "??").map((f) => `  ${f.path} (new)`);
  const wantsCommit = files.length > 0;
  const wantsPr = commits.length > 0;
  const [message, prText] = await Promise.all([
    wantsCommit ? suggestCommitMessage(
      [stat.stdout.trimEnd(), ...untracked].filter(Boolean).join("\n"),
      text.stdout,
      files.length
    ) : Promise.resolve(null),
    wantsPr ? suggestPrText(branch, commits, diffStat.stdout.trimEnd()) : Promise.resolve(null)
  ]);
  const subject = message?.subject ?? "";
  const body = message?.body ?? "";
  const pr = prText ?? { title: subject, body: body || subject };
  return {
    ok: true,
    branch,
    base,
    repoDefault,
    bases,
    pushed,
    willBranch,
    files,
    commits,
    subject,
    body,
    prTitle: pr.title,
    prBody: pr.body,
    existingPr,
    nothingToDo
  };
}
async function shipCompare(args) {
  const cwd = resolveInsideRoots(args.root);
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` };
  const compare = await comparisonRef(cwd, args.base);
  const log = await runGit(cwd, ["log", "--oneline", `${compare}..HEAD`]);
  if (!log.ok) return { ok: false, error: gitErrorOf(log) };
  return { ok: true, commits: log.stdout.split("\n").filter(Boolean) };
}
async function shipPullRequest(args) {
  const cwd = resolveInsideRoots(args.root);
  if (!cwd) return { ok: false, error: `not readable: ${basename(args.root)}` };
  const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) return { ok: false, error: `${basename(args.root)} is not a git repository` };
  const headCommit = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!headCommit.ok)
    return { ok: false, error: "This repository has no commits yet — make one first." };
  const notReady = await ghReady(cwd);
  if (notReady) return { ok: false, error: notReady };
  const head = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return { ok: false, error: gitErrorOf(head) };
  let branch = head.stdout.trim();
  if (branch === "HEAD")
    return { ok: false, error: "Detached HEAD — check out a branch before shipping." };
  const repoDefault = await defaultBranch(cwd);
  const base = await resolveBase(cwd, args.base, repoDefault);
  const route = args.route === "push" ? "push" : "pr";
  const protectedHead = willCutBranch(route, branch, base, repoDefault);
  const wanted = args.renameBranch?.trim();
  if (wanted && wanted !== branch) {
    const bad = await invalidBranchName(cwd, wanted);
    if (bad) return { ok: false, error: bad };
    if ((await localBranches(cwd)).includes(wanted))
      return { ok: false, error: `A branch named ${wanted} already exists.` };
  }
  if (wanted && wanted !== branch && !protectedHead) {
    if (await isPushed(cwd, branch))
      return {
        ok: false,
        error: `${branch} is already on the remote — rename it there, or ship it under this name.`
      };
    const moved = await runGit(cwd, ["branch", "-m", wanted]);
    if (!moved.ok) return { ok: false, error: gitErrorOf(moved) };
    branch = wanted;
  }
  const add = await runGit(cwd, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: gitErrorOf(add) };
  const staged = await runGit(cwd, ["diff", "--cached", "--name-only"]);
  const stagedFiles = staged.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const hasChanges = stagedFiles.length > 0;
  let branchedFrom;
  let committed = false;
  if (hasChanges) {
    let message = args.message;
    if (!message) {
      const stat = await runGit(cwd, ["diff", "--cached", "--stat"]);
      const text = await runGit(cwd, ["diff", "--cached"]);
      message = await suggestCommitMessage(stat.stdout.trimEnd(), text.stdout, stagedFiles.length);
    }
    if (protectedHead) {
      const name = wanted || uniqueBranchName(slugifyBranch(message.subject) || "changes", await localBranches(cwd));
      const cut = await runGit(cwd, ["switch", "-c", name]);
      if (!cut.ok) return { ok: false, error: gitErrorOf(cut) };
      branchedFrom = branch;
      branch = name;
    }
    const argv = ["commit", "-m", message.subject];
    if (message.body) argv.push("-m", message.body);
    const commit2 = await runGit(cwd, argv);
    if (!commit2.ok) return { ok: false, error: gitErrorOf(commit2) };
    committed = true;
  } else if (protectedHead) {
    return {
      ok: false,
      error: `Nothing to ship — no changes, and ${branch} is a branch PRs land on.`
    };
  }
  const compare = await comparisonRef(cwd, base);
  const ahead = await runGit(cwd, ["rev-list", "--count", `${compare}..HEAD`]);
  const commitsAhead = ahead.ok ? Number(ahead.stdout.trim()) || 0 : -1;
  const existing = await openPrUrl(cwd, route === "push" ? base : branch);
  if (!committed && commitsAhead === 0)
    return {
      ok: false,
      error: existing ? "Nothing to ship — the PR is already up to date." : `Nothing to ship — ${branch} has no commits ${base} lacks.`
    };
  if (route === "push") {
    const pushed = await runGit(
      cwd,
      ["push", await pushRemote(cwd), `HEAD:refs/heads/${base}`],
      NETWORK_TIMEOUT_MS
    );
    if (!pushed.ok) return { ok: false, error: gitErrorOf(pushed) };
    return {
      ok: true,
      url: existing ?? "",
      branch,
      base,
      route,
      committed,
      created: false,
      ...branchedFrom && { branchedFrom }
    };
  }
  const tracksSelf = await tracksOwnBranch(cwd, branch);
  const push = tracksSelf ? await runGit(cwd, ["push"], NETWORK_TIMEOUT_MS) : await runGit(cwd, ["push", "--set-upstream", await pushRemote(cwd), branch], NETWORK_TIMEOUT_MS);
  if (!push.ok) return { ok: false, error: gitErrorOf(push) };
  if (existing)
    return { ok: true, url: existing, branch, base, route, committed, created: false, ...branchedFrom && { branchedFrom } };
  const log = await runGit(cwd, ["log", "--oneline", `${compare}..HEAD`]);
  const diffStat = await runGit(cwd, ["diff", "--stat", `${compare}...HEAD`]);
  const pr = args.pr ?? await suggestPrText(
    branch,
    log.ok ? log.stdout.split("\n").filter(Boolean) : [],
    diffStat.stdout.trimEnd()
  );
  const created = await runGh(
    cwd,
    ["pr", "create", "--base", base, "--head", branch, "--title", pr.title, "--body", pr.body || pr.title],
    NETWORK_TIMEOUT_MS
  );
  if (!created.ok) {
    const raced = await openPrUrl(cwd, branch);
    if (raced)
      return { ok: true, url: raced, branch, base, route, committed, created: false, ...branchedFrom && { branchedFrom } };
    return { ok: false, error: ghErrorOf(created) };
  }
  const url = created.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return { ok: true, url, branch, base, route, committed, created: true, ...branchedFrom && { branchedFrom } };
}
async function mergedBranches(root2) {
  const cwd = resolveInsideRoots(root2);
  if (!cwd) return [];
  const res = await runGh(cwd, [
    "pr",
    "list",
    "--state",
    "merged",
    "--json",
    "headRefName",
    "--limit",
    "100"
  ]);
  if (!res.ok) return [];
  try {
    const rows = JSON.parse(res.stdout);
    return rows.map((r) => r.headRefName).filter((n) => Boolean(n));
  } catch {
    return [];
  }
}
async function openPrUrl(cwd, branch) {
  const res = await runGh(cwd, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "1"
  ]);
  if (!res.ok) return null;
  try {
    const rows = JSON.parse(res.stdout);
    return rows[0]?.url ?? null;
  } catch {
    return null;
  }
}
async function tracksOwnBranch(cwd, branch) {
  const merge = await runGit(cwd, ["config", "--get", `branch.${branch}.merge`]);
  return merge.ok && merge.stdout.trim() === `refs/heads/${branch}`;
}
async function pushRemote(cwd) {
  const res = await runGit(cwd, ["remote"]);
  const remotes = res.stdout.split("\n").map((r) => r.trim()).filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes[0] ?? "origin";
}
const enabled = () => app.isPackaged && true && existsSync(join("/Users/martin/Desktop/Projects/chewo", ".git"));
let updating = false;
const errorFile = () => join(app.getPath("home"), ".chewo", "update-error.txt");
function lastUpdateError() {
  try {
    const message = readFileSync(errorFile(), "utf8").trim();
    return message || null;
  } catch {
    return null;
  }
}
const clearUpdateError = () => rmSync(errorFile(), { force: true });
async function getVersionStatus() {
  if (!enabled()) return null;
  if (updating) return { kind: "updating" };
  const head = await runGit("/Users/martin/Desktop/Projects/chewo", ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  if (head.stdout.trim() === "c781c399225e7252555e5d451d6eac9c0dd48d48") {
    clearUpdateError();
    return { kind: "current" };
  }
  const failure = lastUpdateError();
  if (failure) return { kind: "update-failed", message: failure };
  const count = await runGit("/Users/martin/Desktop/Projects/chewo", ["rev-list", "--count", `${"c781c399225e7252555e5d451d6eac9c0dd48d48"}..HEAD`]);
  const commits = count.ok ? Number(count.stdout.trim()) : 0;
  return { kind: "behind", commits: commits > 0 ? commits : 1 };
}
function runSelfUpdate(win) {
  if (!enabled() || updating) return;
  updating = true;
  clearUpdateError();
  safeSend(win, "version:status", { kind: "updating" });
  execFile(
    "/bin/zsh",
    ["-lc", "npm run dist"],
    { cwd: "/Users/martin/Desktop/Projects/chewo", timeout: 15 * 6e4, maxBuffer: 32 * 1024 * 1024 },
    (err, stdout, stderr) => {
      updating = false;
      if (err) {
        const tail = (String(stderr).trim() || String(stdout).trim() || err.message).split("\n").slice(-4).join("\n");
        safeSend(win, "version:status", {
          kind: "update-failed",
          message: tail
        });
        return;
      }
      installAndRelaunch();
    }
  );
}
function installAndRelaunch() {
  const log = join(app.getPath("home"), ".chewo", "update.log");
  mkdirSync(dirname(log), { recursive: true });
  const cmd = `node scripts/install-app.mjs --wait-for ${process.pid} --reopen >> ${JSON.stringify(log)} 2>&1`;
  const child2 = spawn("/bin/zsh", ["-lc", cmd], {
    cwd: "/Users/martin/Desktop/Projects/chewo",
    detached: true,
    stdio: "ignore"
  });
  child2.unref();
  app.exit(0);
}
let watcher = null;
let timer = null;
function watchRepoHead(win) {
  if (!enabled() || watcher) return;
  watcher = chokidar.watch(join("/Users/martin/Desktop/Projects/chewo", ".git", "logs", "HEAD"), { ignoreInitial: true });
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void getVersionStatus().then((status) => {
        if (status) safeSend(win, "version:status", status);
      });
    }, 500);
  });
}
function disposeVersionWatch() {
  if (timer) clearTimeout(timer);
  timer = null;
  void watcher?.close();
  watcher = null;
}
const CODEX_INITIALIZE_ID = 0;
const CODEX_THREAD_ID = 1;
function codexStartupMessages(opts) {
  const thread = {
    ...opts.model ? { model: opts.model } : {},
    cwd: opts.cwd,
    ...opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {},
    ...opts.extraDirs?.length ? { runtimeWorkspaceRoots: [.../* @__PURE__ */ new Set([opts.cwd, ...opts.extraDirs])] } : {},
    ...opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}
  };
  return [
    {
      method: "initialize",
      id: CODEX_INITIALIZE_ID,
      params: {
        clientInfo: { name: "chewo", title: "Chewo", version: "1" },
        capabilities: { experimentalApi: true }
      }
    },
    { method: "initialized", params: {} },
    opts.sessionId ? { method: "thread/resume", id: CODEX_THREAD_ID, params: { threadId: opts.sessionId, ...thread } } : { method: "thread/start", id: CODEX_THREAD_ID, params: thread }
  ];
}
const safeJson = (value) => {
  if (value === null || value === void 0) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
function unifiedPatch(change) {
  if (!change.path || !change.diff) return void 0;
  const hunks = [];
  let current = null;
  for (const line of change.diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? 1),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1),
        lines: []
      };
      hunks.push(current);
      continue;
    }
    if (current && /^[ +\-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---"))
      current.lines.push(line);
  }
  if (!hunks.length) return void 0;
  const kind = change.kind;
  const patch = parseToolPatch({ filePath: change.path, structuredPatch: hunks });
  return patch ? { ...patch, ...kind?.type === "add" ? { created: true } : {} } : void 0;
}
function toolCall(item) {
  if (!item.id) return null;
  switch (item.type) {
    case "commandExecution":
      return {
        toolUseId: item.id,
        name: "shell",
        displayName: "Shell",
        input: { command: item.command ?? "", cwd: item.cwd ?? "" },
        status: "running"
      };
    case "fileChange": {
      const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean);
      return {
        toolUseId: item.id,
        name: "apply_patch",
        displayName: "Edit",
        input: paths.length ? { path: paths[0], ...paths.length > 1 ? { paths } : {} } : {},
        status: "running"
      };
    }
    case "mcpToolCall":
      return {
        toolUseId: item.id,
        name: typeof item.tool === "string" ? item.tool : "mcp",
        displayName: [item.server, item.tool].filter((v) => typeof v === "string").join(" · ") || "MCP",
        input: item.arguments ?? {},
        status: "running"
      };
    case "dynamicToolCall":
      return {
        toolUseId: item.id,
        name: typeof item.tool === "string" ? item.tool : "tool",
        input: item.arguments ?? {},
        status: "running"
      };
    case "webSearch":
      return {
        toolUseId: item.id,
        name: "web_search",
        displayName: "Web search",
        input: { query: item.query ?? "" },
        status: "running"
      };
    case "imageView":
      return {
        toolUseId: item.id,
        name: "view_image",
        displayName: "View image",
        input: { path: item.path ?? "" },
        status: "running"
      };
    case "collabAgentToolCall":
      return {
        toolUseId: item.id,
        name: typeof item.tool === "string" ? item.tool : "Agent",
        input: item,
        status: "running"
      };
    default:
      return null;
  }
}
const taskStatus = (status) => status === "completed" ? "completed" : status === "inProgress" ? "in_progress" : "pending";
function createCodexNormalizer(opts) {
  let activeThreadId = opts.sessionId;
  let activeTurnId;
  const openBlocks = /* @__PURE__ */ new Map();
  const tools = /* @__PURE__ */ new Set();
  const ensureBlock = (id, kind, out) => {
    if (openBlocks.has(id)) return;
    openBlocks.set(id, { kind, text: "" });
    out.push({ type: "block_start", blockId: id, block: kind });
  };
  const addDelta = (id, kind, delta, out) => {
    if (!delta) return;
    ensureBlock(id, kind, out);
    const open = openBlocks.get(id);
    open.text += delta;
    out.push({ type: "block_delta", blockId: id, text: delta });
  };
  const finishBlock = (id, kind, finalText, out) => {
    ensureBlock(id, kind, out);
    const open = openBlocks.get(id);
    if (finalText && finalText.startsWith(open.text)) addDelta(id, kind, finalText.slice(open.text.length), out);
    out.push({ type: "block_end", blockId: id });
    openBlocks.delete(id);
  };
  const ensureTool = (item, out) => {
    const call = toolCall(item);
    if (!call || tools.has(call.toolUseId)) return;
    tools.add(call.toolUseId);
    out.push({ type: "tool_start", call });
  };
  return {
    threadId: () => activeThreadId,
    turnId: () => activeTurnId,
    normalize(raw) {
      if (!raw || typeof raw !== "object") return { events: [] };
      const msg = raw;
      const out = [];
      if (msg.id === CODEX_THREAD_ID) {
        if (msg.error?.message)
          return { events: [{ type: "notice", tone: "error", text: msg.error.message }] };
        const thread = msg.result?.thread;
        const id = typeof thread?.id === "string" ? thread.id : opts.sessionId ?? "";
        activeThreadId = id || activeThreadId;
        const info = {
          sessionId: id,
          model: typeof msg.result?.model === "string" ? msg.result.model : opts.model ?? "",
          cwd: typeof msg.result?.cwd === "string" ? msg.result.cwd : opts.cwd,
          // Slash commands are TUI client actions. App-server does not expose
          // a command catalog, so advertising those strings here would promise
          // commands that a turn/start request cannot execute.
          slashCommands: [],
          mcpServers: []
        };
        return { events: [{ type: "session", info }] };
      }
      const responseTurn = msg.result?.turn;
      if (typeof responseTurn?.id === "string") activeTurnId = responseTurn.id;
      if (msg.error?.message && msg.id !== void 0)
        return { events: [{ type: "notice", tone: "error", text: msg.error.message }] };
      const params = msg.params ?? {};
      const item = params.item;
      switch (msg.method) {
        case "turn/started": {
          const turn = params.turn;
          activeTurnId = turn?.id;
          return { events: [] };
        }
        case "turn/completed": {
          const turn = params.turn;
          activeTurnId = void 0;
          if (turn?.status === "failed" && turn.error?.message)
            out.push({ type: "notice", tone: "error", text: turn.error.message });
          out.push({
            type: "turn_end",
            stats: {
              durationMs: typeof turn?.durationMs === "number" ? turn.durationMs : void 0,
              isError: turn?.status === "failed",
              cancelled: turn?.status === "interrupted"
            }
          });
          return { events: out };
        }
        case "thread/tokenUsage/updated": {
          const usage = params.tokenUsage;
          return {
            events: [{
              type: "usage",
              usage: {
                contextTokens: usage?.last?.inputTokens,
                contextWindow: typeof usage?.modelContextWindow === "number" ? usage.modelContextWindow : void 0
              }
            }]
          };
        }
        case "turn/plan/updated": {
          const plan = Array.isArray(params.plan) ? params.plan : [];
          const tasks = plan.slice(0, 60).flatMap((entry, index) => {
            if (!entry || typeof entry !== "object") return [];
            const p = entry;
            if (typeof p.step !== "string" || !p.step) return [];
            return [{ id: `codex-plan-${index}`, subject: p.step, status: taskStatus(p.status) }];
          });
          return { events: [{ type: "tasks", tasks }] };
        }
        case "item/started":
          if (!item?.id) return { events: [] };
          if (item.type === "agentMessage") ensureBlock(item.id, "text", out);
          else if (item.type === "reasoning") ensureBlock(item.id, "thinking", out);
          else ensureTool(item, out);
          return { events: out };
        case "item/agentMessage/delta":
          addDelta(String(params.itemId ?? ""), "text", String(params.delta ?? ""), out);
          return { events: out };
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta":
          addDelta(String(params.itemId ?? ""), "thinking", String(params.delta ?? ""), out);
          return { events: out };
        case "item/reasoning/summaryPartAdded": {
          const id = String(params.itemId ?? "");
          const open = openBlocks.get(id);
          if (open?.text && !open.text.endsWith("\n")) addDelta(id, "thinking", "\n", out);
          return { events: out };
        }
        case "item/completed": {
          if (!item?.id) return { events: [] };
          if (item.type === "agentMessage") {
            finishBlock(item.id, "text", item.text ?? "", out);
            return { events: out };
          }
          if (item.type === "reasoning") {
            finishBlock(item.id, "thinking", [...item.summary ?? [], ...item.content ?? []].join("\n"), out);
            return { events: out };
          }
          if (item.type === "plan") {
            finishBlock(item.id, "text", item.text ?? "", out);
            return { events: out };
          }
          ensureTool(item, out);
          if (!tools.has(item.id)) return { events: out };
          if (item.type === "commandExecution")
            out.push({
              type: "tool_result",
              toolUseId: item.id,
              result: item.aggregatedOutput ?? "",
              isError: item.status === "failed" || item.status === "declined"
            });
          else if (item.type === "fileChange") {
            const patch = item.changes?.length ? unifiedPatch(item.changes[0]) : void 0;
            out.push({
              type: "tool_result",
              toolUseId: item.id,
              result: item.status === "completed" ? item.changes && item.changes.length > 1 ? `Changed ${item.changes.length} files; previewing the first.` : "" : `File change ${item.status ?? "finished"}`,
              isError: item.status === "failed" || item.status === "declined",
              ...patch ? { patch } : {}
            });
          } else if (item.type === "mcpToolCall")
            out.push({
              type: "tool_result",
              toolUseId: item.id,
              result: item.error?.message ?? safeJson(item.result),
              isError: Boolean(item.error)
            });
          else
            out.push({
              type: "tool_result",
              toolUseId: item.id,
              result: safeJson(item.contentItems ?? item.result),
              isError: item.success === false || item.status === "failed"
            });
          return { events: out };
        }
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": {
          if (msg.id === void 0) return { events: [] };
          const toolUseId = String(params.itemId ?? "");
          const pseudo = msg.method === "item/commandExecution/requestApproval" ? {
            id: toolUseId,
            type: "commandExecution",
            command: String(params.command ?? ""),
            cwd: String(params.cwd ?? "")
          } : { id: toolUseId, type: "fileChange", changes: [] };
          ensureTool(pseudo, out);
          const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
          const canPersist = msg.method === "item/fileChange/requestApproval" || available.includes("acceptForSession");
          const suggestions = canPersist ? [{ type: "codexAcceptForSession", label: "Allow for this session" }] : [];
          const key = String(msg.id);
          out.push({
            type: "tool_approval",
            toolUseId,
            requestId: key,
            description: typeof params.reason === "string" ? params.reason : void 0,
            input: msg.method === "item/commandExecution/requestApproval" ? { command: params.command, cwd: params.cwd } : void 0,
            suggestions
          });
          return {
            events: out,
            pending: {
              key,
              wireId: msg.id,
              toolUseId,
              kind: msg.method === "item/commandExecution/requestApproval" ? "command" : "file"
            }
          };
        }
        case "item/tool/requestUserInput": {
          if (msg.id === void 0) return { events: [] };
          const toolUseId = String(params.itemId ?? `question-${msg.id}`);
          const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
          const questions = rawQuestions.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const q = entry;
            if (typeof q.id !== "string" || typeof q.question !== "string") return [];
            return [{ id: q.id, question: q.question }];
          });
          if (!tools.has(toolUseId)) {
            tools.add(toolUseId);
            out.push({
              type: "tool_start",
              call: {
                toolUseId,
                name: "request_user_input",
                displayName: "Question",
                input: {
                  questions: rawQuestions.map((entry) => {
                    const q = entry;
                    return {
                      question: q.question,
                      header: q.header,
                      options: q.options,
                      multiSelect: false
                    };
                  })
                },
                status: "running"
              }
            });
          }
          const key = String(msg.id);
          out.push({
            type: "tool_approval",
            toolUseId,
            requestId: key,
            input: {
              questions: rawQuestions.map((entry) => {
                const q = entry;
                return { question: q.question, header: q.header, options: q.options };
              })
            },
            requiresUserInteraction: true,
            suggestions: []
          });
          return {
            events: out,
            pending: { key, wireId: msg.id, toolUseId, kind: "question", questions }
          };
        }
        case "error": {
          if (params.willRetry === true) return { events: [] };
          const error = params.error;
          return error?.message ? { events: [{ type: "notice", tone: "error", text: error.message }] } : { events: [] };
        }
        case "warning":
        case "configWarning": {
          const text = String(params.message ?? params.summary ?? "");
          return text ? { events: [{ type: "notice", tone: "info", text }] } : { events: [] };
        }
        default:
          return { events: [] };
      }
    }
  };
}
function codexTurnMessage(id, threadId, text, images, effort, model) {
  return {
    method: "turn/start",
    id,
    params: {
      threadId,
      input: [
        ...text ? [{ type: "text", text, text_elements: [] }] : [],
        ...images.map((path) => ({ type: "localImage", path }))
      ],
      ...effort ? { effort } : {},
      ...model ? { model } : {}
    }
  };
}
function codexInterruptMessage(id, threadId, turnId) {
  return { method: "turn/interrupt", id, params: { threadId, turnId } };
}
function codexApprovalMessage(pending, decision) {
  if (pending.kind === "question") {
    const byText = decision.behavior === "allow" && decision.updatedInput && typeof decision.updatedInput === "object" ? decision.updatedInput.answers ?? {} : {};
    const answers = Object.fromEntries(
      pending.questions.map((q) => [q.id, { answers: byText[q.question] ? [byText[q.question]] : [] }])
    );
    return { id: pending.wireId, result: { answers } };
  }
  const persist = decision.behavior === "allow" && decision.suggestion?.type === "codexAcceptForSession";
  const answer = decision.behavior === "allow" ? persist ? "acceptForSession" : "accept" : "decline";
  return { id: pending.wireId, result: { decision: answer } };
}
const chats = /* @__PURE__ */ new Map();
const INIT_REQUEST_ID = "chewo-init";
function emit(win, id, event) {
  safeSend(win, "chat:event", { id, event });
}
function createChat(win, opts) {
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir();
  const claude = opts.source === "claude";
  const args = claude ? claudeChatArgs({
    model: opts.model,
    effort: opts.effort,
    permissionMode: opts.permissionMode,
    sessionId: opts.sessionId,
    extraDirs: opts.extraDirs,
    appendSystemPrompt: opts.appendSystemPrompt,
    forwardSubagentText: opts.forwardSubagentText
  }) : ["app-server"];
  const setup = opts.setupCommand?.trim();
  const binary = claude ? "claude" : "codex";
  const script = setup ? `{ ${setup} } 1>&2 && exec ${binary} "$@"` : `${binary} "$@"`;
  const proc2 = spawn("/bin/zsh", ["-ilc", script, "chewo", ...args], {
    cwd,
    env: buildPtyEnv(process.env)
  });
  const id = nextPaneId();
  const record = {
    proc: proc2,
    source: opts.source,
    ...claude ? { normalize: createClaudeNormalizer() } : {
      codex: createCodexNormalizer({
        cwd,
        sessionId: opts.sessionId,
        model: opts.model,
        effort: opts.effort,
        approvalPolicy: opts.approvalPolicy,
        extraDirs: opts.extraDirs,
        developerInstructions: opts.appendSystemPrompt
      })
    },
    cwd,
    sessionId: opts.sessionId,
    buffer: "",
    awaiting: /* @__PURE__ */ new Map(),
    interrupted: false,
    setupPhase: Boolean(setup),
    nextRequestId: 10,
    codexRequests: /* @__PURE__ */ new Map(),
    codexInterruptPending: false,
    effort: opts.effort,
    model: opts.model,
    pendingTurns: []
  };
  chats.set(id, record);
  proc2.stdout.on("data", (chunk) => {
    record.setupPhase = false;
    record.buffer += chunk.toString();
    let newline;
    while ((newline = record.buffer.indexOf("\n")) !== -1) {
      const line = record.buffer.slice(0, newline);
      record.buffer = record.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const reply = raw;
      if (claude && reply.type === "control_response" && reply.response?.request_id === INIT_REQUEST_ID) {
        const commands = (reply.response.response?.commands ?? []).map((c) => c.name).filter((n) => Boolean(n));
        if (commands.length) emit(win, id, { type: "capabilities", slashCommands: commands });
        continue;
      }
      const parsed = raw;
      if (parsed.type === "control_request" && parsed.request?.subtype === "can_use_tool" && parsed.request_id)
        record.awaiting.set(parsed.request_id, { toolUseId: parsed.request.tool_use_id ?? "" });
      const rpc = raw;
      const requestId = typeof rpc.id === "number" ? rpc.id : void 0;
      const requestKind = requestId === void 0 ? void 0 : record.codexRequests.get(requestId);
      if (requestId !== void 0) record.codexRequests.delete(requestId);
      const normalized = record.codex?.normalize(raw);
      if (normalized?.pending)
        record.awaiting.set(normalized.pending.key, {
          toolUseId: normalized.pending.toolUseId,
          codex: normalized.pending
        });
      const events = normalized?.events ?? record.normalize?.(raw) ?? [];
      if (requestKind === "turn" && rpc.error) {
        events.push({ type: "turn_end", stats: { isError: true } });
      } else if (rpc.id === CODEX_THREAD_ID && rpc.error && record.pendingTurns.length) {
        record.pendingTurns = [];
        events.push({ type: "turn_end", stats: { isError: true } });
      }
      if (record.codexInterruptPending && record.codex) {
        const threadId = record.codex.threadId();
        const turnId = record.codex.turnId();
        if (threadId && turnId) sendCodexInterrupt(record, threadId, turnId);
      }
      for (const event of events) {
        if (event.type === "session") record.sessionId = event.info.sessionId;
        if (event.type === "session" && record.codex && record.pendingTurns.length) {
          const threadId = record.codex.threadId();
          if (threadId) {
            for (const turn of record.pendingTurns) startCodexTurn(record, threadId, turn);
            record.pendingTurns = [];
          }
        }
        if (event.type === "turn_end") record.codexInterruptPending = false;
        if (record.source === "claude" && event.type === "turn_end" && record.interrupted) {
          record.interrupted = false;
          emit(win, id, { type: "turn_end", stats: { ...event.stats, cancelled: true } });
          continue;
        }
        emit(win, id, event);
      }
    }
  });
  proc2.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    if (record.setupPhase) emit(win, id, { type: "notice", tone: "info", text: text.slice(0, 2e3) });
    else if (/error|not found|denied|fatal/i.test(text))
      emit(win, id, { type: "notice", tone: "error", text: text.slice(0, 500) });
  });
  proc2.stdin.on("error", () => void 0);
  proc2.on("error", (err) => {
    emit(win, id, { type: "notice", tone: "error", text: `Could not start ${opts.source}: ${err.message}` });
    emit(win, id, { type: "exit", code: -1 });
    chats.delete(id);
  });
  proc2.on("close", (code) => {
    emit(win, id, { type: "exit", code: code ?? 0 });
    chats.delete(id);
  });
  if (claude)
    writeJson(record, {
      type: "control_request",
      request_id: INIT_REQUEST_ID,
      request: { subtype: "initialize", hooks: {} }
    });
  else
    for (const message of codexStartupMessages({
      cwd,
      sessionId: opts.sessionId,
      model: opts.model,
      effort: opts.effort,
      approvalPolicy: opts.approvalPolicy,
      extraDirs: opts.extraDirs,
      developerInstructions: opts.appendSystemPrompt
    }))
      writeJson(record, message);
  return id;
}
function writeJson(record, message) {
  record.proc.stdin.write(`${JSON.stringify(message)}
`);
}
function startCodexTurn(record, threadId, turn) {
  const requestId = record.nextRequestId++;
  record.codexRequests.set(requestId, "turn");
  writeJson(
    record,
    codexTurnMessage(requestId, threadId, turn.text, turn.images, record.effort, record.model)
  );
}
function sendCodexInterrupt(record, threadId, turnId) {
  const requestId = record.nextRequestId++;
  record.codexRequests.set(requestId, "interrupt");
  record.codexInterruptPending = false;
  writeJson(record, codexInterruptMessage(requestId, threadId, turnId));
}
function sendChat(win, id, text, images) {
  const record = chats.get(id);
  if (!record) return false;
  if (record.codex) {
    const turn = { text, images: images ?? [] };
    const threadId = record.codex.threadId();
    if (threadId) startCodexTurn(record, threadId, turn);
    else record.pendingTurns.push(turn);
    emit(win, id, { type: "busy", busy: true });
    return true;
  }
  const blocks = images?.length ? imageBlocks(images) : [];
  const content = blocks.length ? [...text ? [{ type: "text", text }] : [], ...blocks] : text;
  writeJson(record, { type: "user", message: { role: "user", content } });
  emit(win, id, { type: "busy", busy: true });
  return true;
}
function respondChat(win, id, requestId, decision) {
  const record = chats.get(id);
  if (!record || !record.awaiting.has(requestId)) return;
  const awaiting = record.awaiting.get(requestId);
  const toolUseId = awaiting.toolUseId;
  record.awaiting.delete(requestId);
  if (awaiting.codex) {
    writeJson(record, codexApprovalMessage(awaiting.codex, decision));
    if (decision.behavior === "deny" && toolUseId)
      emit(win, id, { type: "tool_denied", toolUseId });
    return;
  }
  const response = decision.behavior === "allow" ? {
    behavior: "allow",
    updatedInput: decision.updatedInput ?? {},
    ...decision.suggestion ? { updatedPermissions: [decision.suggestion] } : {}
  } : { behavior: "deny", message: decision.message ?? "Denied by the user." };
  writeJson(record, {
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response }
  });
  if (decision.behavior === "deny" && toolUseId)
    emit(win, id, { type: "tool_denied", toolUseId });
}
function setChatModel(id, model) {
  const record = chats.get(id);
  if (!record) return false;
  record.model = model;
  if (record.codex) return true;
  writeJson(record, {
    type: "control_request",
    request_id: `set-model-${Date.now()}`,
    // An empty pick means the CLI's own default, which is what its schema
    // reads a null model as — never the string 'default' spelled out here.
    request: { subtype: "set_model", model: model || null }
  });
  return true;
}
function setChatEffort(id, effort) {
  const record = chats.get(id);
  if (!record) return false;
  record.effort = effort;
  if (record.codex) return true;
  if (!effort) return true;
  writeJson(record, { type: "user", message: { role: "user", content: `/effort ${effort}` } });
  return true;
}
function interruptChat(id) {
  const record = chats.get(id);
  if (!record) return;
  if (record.codex) {
    const threadId = record.codex.threadId();
    const turnId = record.codex.turnId();
    if (threadId && turnId) sendCodexInterrupt(record, threadId, turnId);
    else record.codexInterruptPending = true;
    return;
  }
  record.interrupted = true;
  writeJson(record, {
    type: "control_request",
    request_id: `interrupt-${Date.now()}`,
    request: { subtype: "interrupt" }
  });
}
function killChat(id) {
  const record = chats.get(id);
  if (!record) return;
  record.proc.stdin.end();
  record.proc.kill();
  chats.delete(id);
}
function chatSessionId(id) {
  return chats.get(id)?.sessionId;
}
function disposeAllChats() {
  for (const record of chats.values()) {
    record.proc.stdin.end();
    record.proc.kill();
  }
  chats.clear();
}
if (!app.isPackaged) {
  app.setPath("userData", `${app.getPath("userData")}-dev`);
}
let mainWindow = null;
const STARTUP_REVEAL_TIMEOUT_MS = 1e4;
const startupRevealTimers = /* @__PURE__ */ new Map();
function revealWindow(win) {
  const timer2 = startupRevealTimers.get(win.webContents.id);
  if (timer2) clearTimeout(timer2);
  startupRevealTimers.delete(win.webContents.id);
  if (!win.isDestroyed()) win.show();
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Chewo",
    // React first renders with dependency-free defaults, then hydrates the
    // user's projects and appearance over IPC. Keep that placeholder frame
    // off-screen; the renderer reveals the window once both files are applied.
    show: false,
    // User's base color — resize flashes match the theme, not stock graphite
    backgroundColor: loadSettings().appearance.base,
    // Frameless-inset: traffic lights float over the sidebar's top drag strip
    // (the 40px `-webkit-app-region: drag` zone above the workflow switcher).
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts (.mjs) require an unsandboxed renderer
      sandbox: false,
      // Chromium's built-in PDF viewer — the editor's .pdf preview iframe
      plugins: true
    }
  });
  const win = mainWindow;
  const revealTimer = setTimeout(() => revealWindow(win), STARTUP_REVEAL_TIMEOUT_MS);
  startupRevealTimers.set(win.webContents.id, revealTimer);
  win.once("closed", () => {
    clearTimeout(revealTimer);
    startupRevealTimers.delete(win.webContents.id);
  });
  mainWindow.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (!isMainFrame || isSameDocument) return;
    disposeAllWatches();
    disposeAllGitWatches();
  });
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  const appFile = pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  const isAppPage = (url) => devServer ? url.startsWith(devServer) : url.split(/[?#]/)[0] === appFile;
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (isAppPage(url)) return;
    e.preventDefault();
    openInBrowser(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: "deny" };
  });
  if (devServer) {
    mainWindow.loadURL(devServer);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  void shell.openExternal(url);
  return true;
}
function registerIpc() {
  ipcMain.on("app:ready", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === mainWindow) revealWindow(win);
  });
  ipcMain.handle("sessions:list", () => scanAll());
  ipcMain.handle(
    "sessions:get",
    (_e, ref) => loadSession(ref.source, ref.filePath)
  );
  ipcMain.handle("terminal:create", (_e, opts) => {
    if (!mainWindow) throw new Error("no window");
    return createTerminal(mainWindow, opts);
  });
  ipcMain.on(
    "terminal:input",
    (_e, { id, data }) => writeTerminal(id, data)
  );
  ipcMain.on(
    "terminal:resize",
    (_e, { id, cols, rows }) => resizeTerminal(id, cols, rows)
  );
  ipcMain.on("terminal:kill", (_e, { id }) => killTerminal(id));
  ipcMain.handle("pane:reserve", () => nextPaneId());
  ipcMain.handle(
    "chat:create",
    async (_e, opts) => {
      if (!mainWindow) throw new Error("no window");
      const appendSystemPrompt = opts.orchestrate ? await orchestratorPrompt(opts.cwd) : "";
      return createChat(mainWindow, {
        ...opts,
        appendSystemPrompt,
        forwardSubagentText: Boolean(appendSystemPrompt)
      });
    }
  );
  ipcMain.on(
    "chat:send",
    (_e, { id, text, images }) => {
      if (mainWindow) sendChat(mainWindow, id, text, images);
    }
  );
  ipcMain.handle(
    "attachment:stage",
    (_e, { base64, mimeType }) => stageImage(base64, mimeType)
  );
  ipcMain.on(
    "chat:respond",
    (_e, { id, requestId, decision }) => {
      if (mainWindow) respondChat(mainWindow, id, requestId, decision);
    }
  );
  ipcMain.on(
    "chat:setModel",
    (_e, { id, model }) => setChatModel(id, model)
  );
  ipcMain.on(
    "chat:setEffort",
    (_e, { id, effort }) => setChatEffort(id, effort)
  );
  ipcMain.on("chat:interrupt", (_e, { id }) => interruptChat(id));
  ipcMain.on("chat:kill", (_e, { id }) => killChat(id));
  ipcMain.handle("chat:sessionId", (_e, { id }) => chatSessionId(id));
  ipcMain.handle(
    "chat:commands",
    (_e, { source, cwd }) => source === "claude" ? claudeSlashCommands(cwd) : []
  );
  ipcMain.handle(
    "usage:account",
    (_e, { source, force }) => source === "codex" ? codexAccountUsage(force === true) : accountUsage(force === true)
  );
  ipcMain.handle(
    "capabilities:scan",
    async (_e, projects) => scanCapabilities(projects, { plugins: await listInstalledPlugins() })
  );
  ipcMain.handle(
    "capabilities:copySkill",
    (_e, args) => copySkill(args.sourceDir, args.destinations, args.overwrite)
  );
  ipcMain.handle(
    "capabilities:copyAgent",
    (_e, args) => copyAgent(args.sourcePath, args.destinations, args.overwrite)
  );
  ipcMain.handle(
    "capabilities:copyMemory",
    (_e, args) => copyMemoryFile(args.sourcePath, args.destinations)
  );
  ipcMain.handle("capabilities:readMemory", (_e, path) => readMemoryFile(path));
  ipcMain.handle("capabilities:readAgent", (_e, path) => readAgentFile(path));
  ipcMain.handle("capabilities:dispatchable", (_e, cwd) => dispatchableAgents(cwd));
  ipcMain.handle(
    "capabilities:copyMcp",
    (_e, args) => copyMcp(args.ref, args.destinations, args.overwrite)
  );
  ipcMain.handle(
    "capabilities:copyHook",
    (_e, args) => copyHook(args.ref, args.destinations)
  );
  ipcMain.handle("capabilities:draftAgent", (_e, req) => draftAgent(req));
  ipcMain.handle(
    "capabilities:writeAgent",
    (_e, args) => writeAgent(args.draft, args.dest, args.overwrite)
  );
  ipcMain.handle("worktree:branches", (_e, projectPath) => listBranches(projectPath));
  ipcMain.handle("worktree:list", (_e, projectPath) => listWorktrees(projectPath));
  ipcMain.handle(
    "worktree:prune-branches",
    (_e, projectPath, merged) => pruneMergedBranches(projectPath, merged)
  );
  ipcMain.handle(
    "worktree:prune-candidates",
    (_e, projectPath) => pruneCandidates(projectPath)
  );
  ipcMain.handle(
    "worktree:state",
    (_e, a) => worktreeState(a.projectPath, a.worktreePath, a.branch, a.baseCommit)
  );
  ipcMain.handle(
    "worktree:create",
    async (_e, a) => {
      const res = await createWorktree(a.projectPath, a.taskName, a.base);
      if (res.ok) {
        const copy = await copyLocalFiles(
          a.projectPath,
          res.path,
          parseLocalFilePatterns(a.localFiles)
        );
        if (copy.error)
          safeSend(mainWindow, "app:toast", `Local files not copied to ${a.taskName}: ${copy.error}`);
      }
      if (res.ok)
        void cloneNodeModules(a.projectPath, res.path).then((err) => {
          if (err) safeSend(mainWindow, "app:toast", `node_modules not copied to ${a.taskName}: ${err}`);
        });
      return res;
    }
  );
  ipcMain.handle(
    "worktree:remove",
    (_e, a) => removeWorktree(a.projectPath, a.worktreePath, a.branch, a.discard)
  );
  ipcMain.handle("git:status", (_e, root2) => gitStatus(root2));
  ipcMain.handle("git:log", (_e, a) => gitLog(a.root, a.limit));
  ipcMain.handle(
    "git:show",
    (_e, a) => gitCommitDetail(a.root, a.hash)
  );
  ipcMain.handle(
    "git:diff",
    (_e, a) => gitDiff(a.root, a.spec)
  );
  ipcMain.handle(
    "git:untracked-files",
    (_e, a) => gitUntrackedFiles(a.root, a.dir)
  );
  ipcMain.handle("git:list-files", (_e, root2) => gitListFiles(root2));
  ipcMain.handle(
    "git:discard",
    (_e, a) => discardChanges(a.root, a.paths)
  );
  ipcMain.handle("git:watch", (_e, root2) => {
    if (!mainWindow) throw new Error("no window");
    return startGitWatch(mainWindow, root2);
  });
  ipcMain.on("git:unwatch", (_e, a) => stopGitWatch(a.watchId));
  ipcMain.handle("git:update", (_e, root2) => gitUpdateFromBase(root2));
  ipcMain.handle("git:fetch", (_e, root2) => gitFetchRemote(root2));
  ipcMain.handle("git:default-base", (_e, root2) => gitDefaultBase(root2));
  ipcMain.handle("git:stale-checkout", (_e, root2) => staleCheckout(root2));
  ipcMain.handle(
    "git:switch",
    (_e, a) => gitSwitchBranch(a.root, a.branch)
  );
  ipcMain.handle("git:ship", (_e, a) => shipPullRequest(a));
  ipcMain.handle("git:ship-preview", (_e, a) => shipPreview(a));
  ipcMain.handle("git:ship-compare", (_e, a) => shipCompare(a));
  ipcMain.handle("git:merged-branches", (_e, root2) => mergedBranches(root2));
  ipcMain.handle("open-external", (_e, url) => openInBrowser(url));
  ipcMain.handle("notes:scan", () => scanNotes());
  ipcMain.handle("notes:read", (_e, path) => readNote(path));
  ipcMain.handle(
    "notes:write",
    (_e, a) => writeNote(a.path, a.content)
  );
  ipcMain.handle("notes:createSubject", (_e, name) => createSubject(name));
  ipcMain.handle(
    "notes:createTopic",
    (_e, a) => createTopic(a.subject, a.name)
  );
  ipcMain.handle("notes:createNote", (_e, args) => createNote(args));
  ipcMain.handle(
    "notes:rename",
    (_e, a) => renameNoteItem(a.path, a.newName)
  );
  ipcMain.handle("notes:delete", (_e, path) => deleteNoteItem(path));
  ipcMain.handle("notes:structure", (_e, args) => structureTranscript(args));
  ipcMain.handle("todos:board", (_e, scopeDir) => loadBoard(scopeDir));
  ipcMain.handle(
    "todos:addCard",
    (_e, a) => addCard(a.scopeDir, a.title, a.status)
  );
  ipcMain.handle(
    "todos:moveCard",
    (_e, a) => moveCard(a.scopeDir, a.cardId, a.to)
  );
  ipcMain.handle("todos:updateCard", (_e, args) => updateCard(args));
  ipcMain.handle(
    "todos:deleteCard",
    (_e, a) => deleteCard(a.scopeDir, a.cardId)
  );
  ipcMain.handle("todos:archiveDone", (_e, scopeDir) => archiveDone(scopeDir));
  ipcMain.handle("todos:archive", (_e, scopeDir) => loadArchive(scopeDir));
  ipcMain.handle(
    "todos:restoreArchived",
    (_e, a) => restoreArchived(a.scopeDir, a.cardId)
  );
  ipcMain.handle(
    "todos:deleteArchived",
    (_e, a) => deleteArchived(a.scopeDir, a.cardId)
  );
  ipcMain.handle("todos:emptyArchive", (_e, scopeDir) => emptyArchiveFile(scopeDir));
  ipcMain.handle("todos:deleteScope", (_e, scopeDir) => deleteScope(scopeDir));
  ipcMain.handle("todos:assetsDir", (_e, scopeDir) => assetsDir(scopeDir));
  ipcMain.handle(
    "todos:markRun",
    (_e, a) => markCardRun(a.scopeDir, a.cardId)
  );
  ipcMain.handle(
    "todos:readAsset",
    (_e, a) => readAsset(a.scopeDir, a.fileName)
  );
  ipcMain.on(
    "stt:start",
    (_e, {
      owner: owner2,
      source,
      lessonPath,
      style
    }) => {
      const win = mainWindow;
      if (!win) return;
      const who = owner2 === "chat" ? "chat" : "notes";
      const err = sttStart(who, (ev) => safeSend(win, "stt:event", ev), source ?? "mic", {
        lessonPath,
        style
      });
      if (err) safeSend(win, "stt:event", { event: "error", owner: who, message: err });
    }
  );
  ipcMain.on("stt:stop", () => sttStop());
  ipcMain.handle(
    "stt:status",
    () => ({
      hasKey: hasDeepgramKey(),
      pendingRecoveries: pendingRecordings().map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        durationS: r.durationS,
        bytes: r.bytes,
        lessonPath: r.lessonPath
      }))
    })
  );
  ipcMain.handle("stt:setKey", (_e, key) => setDeepgramKey(key));
  ipcMain.handle("stt:clearKey", () => clearDeepgramKey());
  ipcMain.handle("stt:testKey", (_e, key) => verifyKey(key || (deepgramKey() ?? "")));
  ipcMain.handle("stt:models", async () => {
    const key = deepgramKey();
    if (!key) return [];
    try {
      return await listStreamingModels(key);
    } catch {
      return [];
    }
  });
  ipcMain.handle("stt:recover", async (_e, id) => {
    const key = deepgramKey();
    if (!key) return { ok: false, error: "Add a Deepgram API key first." };
    return recoverRecording(id, key);
  });
  ipcMain.handle("stt:discardRecording", (_e, id) => discardRecording(id));
  ipcMain.handle("stt:legacyModels", () => ({
    dir: legacyModelsDir(),
    bytes: legacyModelsBytes()
  }));
  ipcMain.handle("stt:removeLegacyModels", () => removeLegacyModels());
  ipcMain.on("noteschat:send", (_e, args) => {
    if (mainWindow) notesChatSend(mainWindow, args);
  });
  ipcMain.on("noteschat:cancel", () => notesChatCancel());
  ipcMain.handle("fs:readDir", (_e, path) => readDir(path));
  ipcMain.handle("fs:readFile", (_e, path) => readFile(path));
  ipcMain.handle("fs:isFile", (_e, path) => isFile(path));
  ipcMain.handle(
    "fs:writeFile",
    (_e, a) => writeFile(a.path, a.content)
  );
  ipcMain.handle(
    "fs:rename",
    (_e, a) => renameEntry(a.path, a.newName)
  );
  ipcMain.handle("fs:delete", (_e, path) => deleteEntry(path));
  ipcMain.handle(
    "fs:copy",
    (_e, a) => copyEntry(a.srcPath, a.destDir)
  );
  ipcMain.handle(
    "fs:move",
    (_e, a) => moveEntry(a.srcPath, a.destDir)
  );
  ipcMain.handle(
    "fs:create",
    (_e, a) => createEntry(a.dirPath, a.name, a.isDir)
  );
  ipcMain.handle("fs:reveal", (_e, path) => revealEntry(path));
  ipcMain.handle("fs:watch", () => {
    if (!mainWindow) throw new Error("no window");
    return startWatch(mainWindow);
  });
  ipcMain.on(
    "fs:watchAdd",
    (_e, a) => watchAdd(a.watchId, a.path)
  );
  ipcMain.on(
    "fs:watchRemove",
    (_e, a) => watchRemove(a.watchId, a.path)
  );
  ipcMain.on("fs:unwatch", (_e, a) => stopWatch(a.watchId));
  ipcMain.handle("projects:load", () => loadProjects());
  ipcMain.handle("projects:save", (_e, file) => {
    saveProjects(file);
    publishScopeIndex(file);
    const err = updateTodoHotkey(file.todoHotkey);
    if (err) safeSend(mainWindow, "app:toast", err);
  });
  ipcMain.handle("agents:models", (_e, agent) => listAgentModels(agent));
  ipcMain.handle("mcp:status", () => mcpServerStatus());
  ipcMain.handle("mcp:connect", (_e, agent) => connectMcpServer(agent));
  ipcMain.handle("mcp:disconnect", (_e, agent) => disconnectMcpServer(agent));
  ipcMain.handle("settings:load", () => loadSettings());
  ipcMain.handle("settings:save", (_e, file) => {
    saveSettings(file);
    mainWindow?.setBackgroundColor(file.appearance.base);
  });
  ipcMain.handle("version:get", () => getVersionStatus());
  ipcMain.on("version:update", () => {
    if (mainWindow) runSelfUpdate(mainWindow);
  });
  ipcMain.handle("dialog:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Add Project"
    });
    return result.canceled ? null : result.filePaths[0];
  });
}
function bindNewSessions(sessions) {
  const panes = getUnboundPanes();
  if (panes.length === 0) return;
  for (const session of sessions) {
    const pane = matchSessionToPane(panes, session);
    if (!pane) continue;
    bindPaneSession(pane.termId, session.id);
    panes.splice(panes.indexOf(pane), 1);
    safeSend(mainWindow, "terminal:session-bound", {
      id: pane.termId,
      sessionId: session.id,
      title: session.title
    });
    if (panes.length === 0) break;
  }
}
function watchSessionStores() {
  const watchers = [
    chokidar.watch(CLAUDE_ROOT, { ignoreInitial: true, depth: 1 }),
    chokidar.watch([join(CODEX_ROOT, "sessions"), join(CODEX_ROOT, "session_index.jsonl")], {
      ignoreInitial: true,
      depth: 4
    })
  ];
  let timer2 = null;
  const onChange = () => {
    if (timer2) clearTimeout(timer2);
    timer2 = setTimeout(() => {
      timer2 = null;
      const result = scanAll();
      bindNewSessions(result.sessions);
      safeSend(mainWindow, "sessions:changed", result);
    }, 1e3);
  };
  for (const watcher2 of watchers) watcher2.on("all", onChange);
  app.on("before-quit", () => {
    for (const watcher2 of watchers) void watcher2.close();
  });
}
function watchNotesStore() {
  const watcher2 = chokidar.watch(getNotesRoot(), { ignoreInitial: true, depth: 3 });
  let timer2 = null;
  watcher2.on("all", () => {
    if (timer2) clearTimeout(timer2);
    timer2 = setTimeout(() => safeSend(mainWindow, "notes:changed"), 400);
  });
  app.on("before-quit", () => watcher2.close());
}
function publishScopeIndex(file) {
  try {
    writeScopeIndex(
      file.projects.map((p) => ({
        dir: projectScopeDir(p.name, p.path),
        name: p.name,
        path: p.path
      }))
    );
  } catch {
  }
}
function watchTodosStore() {
  const watcher2 = chokidar.watch(todosRootPath(), { ignoreInitial: true, depth: 2 });
  const timers = /* @__PURE__ */ new Map();
  watcher2.on("all", (_event, path) => {
    if (!path.endsWith("board.json")) return;
    const scopeDir = basename(dirname(path));
    if (scopeDir === GENERAL_SCOPE || scopeDir.startsWith("p-")) {
      clearTimeout(timers.get(scopeDir));
      timers.set(
        scopeDir,
        setTimeout(() => safeSend(mainWindow, "todos:changed", { scopeDir }), 250)
      );
    }
  });
  app.on("before-quit", () => watcher2.close());
}
function watchHandoffInbox() {
  adoptLegacyMcpRoot();
  const inboxRoot = join(MCP_ROOT, "inbox");
  mkdirSync(join(inboxRoot, "claude"), { recursive: true });
  mkdirSync(join(inboxRoot, "codex"), { recursive: true });
  const watcher2 = chokidar.watch(inboxRoot, { ignoreInitial: true, depth: 2 });
  watcher2.on("add", (path) => {
    if (!path.endsWith(".json")) return;
    const agent = basename(dirname(path));
    if (agent !== "claude" && agent !== "codex") return;
    let from = "";
    let note = "";
    try {
      const handoff = JSON.parse(readFileSync(path, "utf8"));
      from = handoff.from ?? "";
      note = (handoff.note ?? "").slice(0, 200);
    } catch {
    }
    const nudged = nudgeAgentPane(agent);
    safeSend(mainWindow, "handoff:received", { to: agent, from, note, nudged });
  });
  app.on("before-quit", () => watcher2.close());
}
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "togglefullscreen" }
        ]
      },
      { role: "windowMenu" }
    ])
  );
}
app.whenReady().then(() => {
  const projectsFile = loadProjects();
  if (projectsFile.notesRoot) setNotesRoot(projectsFile.notesRoot);
  buildMenu();
  registerIpc();
  createWindow();
  if (mainWindow) {
    setSttBroadcast((ev) => safeSend(mainWindow, "stt:event", ev));
    setTodosWindow(mainWindow);
    initTodoVoice(mainWindow, projectsFile.todoHotkey);
    mainWindow.on("closed", () => closeHud());
  }
  publishScopeIndex(projectsFile);
  pruneAttachments();
  if (mainWindow) watchRepoHead(mainWindow);
  watchSessionStores();
  watchNotesStore();
  watchTodosStore();
  watchHandoffInbox();
  void reconcileMcpServer();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  disposeAllTerminals();
  disposeAllChats();
  disposeAllWatches();
  disposeAllGitWatches();
  disposeVersionWatch();
  disposeSidecar();
  disposeTodoVoice();
  app.quit();
});
app.on("before-quit", () => {
  disposeAllTerminals();
  disposeAllChats();
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    disposeAllTerminals();
    disposeAllChats();
    app.quit();
  });
}
