/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { selectModel } from './router.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

// --- Dynamic Model Routing (Feature 1) ---
let MODEL_HAIKU = '';
let MODEL_SONNET = '';
let MODEL_OPUS = '';

async function loadModels(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey });
  const modelIds: string[] = [];
  for await (const model of client.models.list()) {
    modelIds.push(model.id);
  }
  // Sort newest first (ISO date suffixes sort lexicographically)
  modelIds.sort().reverse();

  const haiku = modelIds.find((id) => id.includes('haiku'));
  const sonnet = modelIds.find((id) => id.includes('sonnet'));
  const opus = modelIds.find((id) => id.includes('opus'));

  if (haiku) MODEL_HAIKU = haiku;
  if (sonnet) MODEL_SONNET = sonnet;
  if (opus) MODEL_OPUS = opus;

  log(`Models loaded — Haiku: ${MODEL_HAIKU}, Sonnet: ${MODEL_SONNET}, Opus: ${MODEL_OPUS}`);
}



// --- Loop Guards (Feature 2) ---
const MAX_CONSECUTIVE_ERRORS = 8;
const TOKEN_SOFT_LIMIT = 50000;
const TOKEN_HARD_LIMIT = 100000;
const MESSAGES_DIR = '/workspace/ipc/messages';
const TOKEN_LOGS_DIR = '/workspace/ipc/token_logs';
const GUARD_LOGS_DIR = '/workspace/ipc/guard_logs';

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
  currentSessionModel?: string
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean; pendingModelSwitchMessage?: string; killSessionRequested?: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let pendingModelSwitchMessage: string | undefined;
  let killSessionRequested = false;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      const lowerText = text.trim().toLowerCase();
      if (lowerText === '/kill' || lowerText === '/reset') {
        log('Kill/reset command received via IPC, ending stream');
        killSessionRequested = true;
        stream.end();
        ipcPolling = false;
        return;
      }

      const selectedModel = selectModel(text, { haiku: MODEL_HAIKU, sonnet: MODEL_SONNET, opus: MODEL_OPUS });
      if (currentSessionModel && currentSessionModel !== selectedModel) {
        log(`Model switch detected during IPC poll (${currentSessionModel} -> ${selectedModel}). Ending query to restart.`);
        pendingModelSwitchMessage = text;
        stream.end();
        ipcPolling = false;
        return;
      }

      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // --- Loop guard state ---
  let consecutiveErrorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let guardTriggered = false;

  function writeGuardAlert(text: string): void {
    try {
      fs.mkdirSync(MESSAGES_DIR, { recursive: true });
      const filename = `${Date.now()}-guard-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(MESSAGES_DIR, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({
        type: 'message',
        chatJid: containerInput.chatJid,
        text,
        groupFolder: containerInput.groupFolder,
        timestamp: new Date().toISOString(),
      }));
      fs.renameSync(tempPath, filepath);
    } catch (err) {
      log(`Failed to write guard alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function writeGuardLog(reason: string, turnCnt: number, tokenCnt: number): void {
    try {
      fs.mkdirSync(GUARD_LOGS_DIR, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(GUARD_LOGS_DIR, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({
        type: 'guard_trigger',
        reason,
        group_folder: containerInput.groupFolder,
        turn_count: turnCnt,
        token_count: tokenCnt,
        task_type: containerInput.isScheduledTask ? 'scheduled_task' : 'message',
        timestamp: new Date().toISOString(),
      }));
      fs.renameSync(tempPath, filepath);
    } catch (err) {
      log(`Failed to write guard log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      model: sdkEnv['CLAUDE_MODEL'],
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__ms365__*',
        'mcp__gmail1__*',
        'mcp__gmail2__*',
        'mcp__gcal__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            SENRI_API_KEY: sdkEnv['SENRI_API_KEY'] || '',
            SENRI_API_SECRET: sdkEnv['SENRI_API_SECRET'] || '',
          },
        },
        ...(sdkEnv['MS365_ENABLED'] === 'true' ? {
          ms365: {
            type: 'http' as const,
            url: 'http://host.docker.internal:3100/mcp',
          },
        } : {}),
        gmail1: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
          env: { HOME: '/home/node/.gmail-mcp-1' },
        },
        gmail2: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
          env: { HOME: '/home/node/.gmail-mcp-2' },
        },
        gcal: {
          command: 'npx',
          args: ['-y', '@gongrzhe/server-calendar-autoauth-mcp'],
          env: { HOME: '/home/node/.gcal-mcp' },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook()] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    // Token tracking moved to result event

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const isError = message.subtype === 'error_during_execution' || message.subtype === 'error_max_turns' || message.subtype === 'error_max_budget_usd' || message.subtype === 'error_max_structured_output_retries';

      if (isError) {
        consecutiveErrorCount++;
        log(`Result #${resultCount} [ERROR ${consecutiveErrorCount}/${MAX_CONSECUTIVE_ERRORS}]: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      } else {
        consecutiveErrorCount = 0;
        log(`Result #${resultCount} [OK]: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      }

      let currentInputTokens = 0;
      let currentOutputTokens = 0;
      let currentCacheReadTokens = 0;
      let currentCacheCreateTokens = 0;
      if ('usage' in message && message.usage) {
        const u = message.usage as any;
        // Per Anthropic docs: input_tokens = only uncached tokens after last cache breakpoint
        // Total input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
        const rawInputTokens = u.input_tokens || 0;
        currentCacheReadTokens = u.cache_read_input_tokens || 0;
        currentCacheCreateTokens = u.cache_creation_input_tokens || 0;
        currentInputTokens = rawInputTokens + currentCacheReadTokens + currentCacheCreateTokens;
        currentOutputTokens = u.output_tokens || 0;
        log(`[tokens] raw_input=${rawInputTokens} cache_read=${currentCacheReadTokens} cache_create=${currentCacheCreateTokens} total_input=${currentInputTokens} output=${currentOutputTokens}`);
      }

      const turnInputTokens = currentInputTokens - totalInputTokens;
      const turnOutputTokens = currentOutputTokens - totalOutputTokens;
      const turnCacheReadTokens = currentCacheReadTokens - totalCacheReadTokens;
      const turnCacheCreateTokens = currentCacheCreateTokens - totalCacheCreationTokens;

      totalInputTokens = currentInputTokens;
      totalOutputTokens = currentOutputTokens;
      totalCacheReadTokens = currentCacheReadTokens;
      totalCacheCreationTokens = currentCacheCreateTokens;

      const totalTokens = totalInputTokens + totalOutputTokens;

      // Token soft limit warning
      if (totalTokens >= TOKEN_SOFT_LIMIT && totalTokens < TOKEN_HARD_LIMIT && !guardTriggered) {
        log(`Guard warning: token budget soft limit (${TOKEN_SOFT_LIMIT}) reached — ${totalTokens} tokens used`);
        writeGuardAlert(`⚠️ Token budget warning: ${totalTokens} tokens used (soft limit: ${TOKEN_SOFT_LIMIT}) for group ${containerInput.groupFolder}`);
        writeGuardLog('token_budget_soft', consecutiveErrorCount, totalTokens);
      }

      // Token hard limit kill
      if (totalTokens >= TOKEN_HARD_LIMIT) {
        log(`Guard KILL: token budget hard limit (${TOKEN_HARD_LIMIT}) reached — ${totalTokens} tokens used`);
        writeGuardAlert(`🛑 Session killed: token budget exceeded (${totalTokens}/${TOKEN_HARD_LIMIT}) for group ${containerInput.groupFolder}`);
        writeGuardLog('token_budget_hard', consecutiveErrorCount, totalTokens);
        guardTriggered = true;
        stream.end();
        break;
      }

      writeOutput({
        status: isError ? 'error' : 'success',
        result: textResult || null,
        newSessionId
      });

      // --- Write token usage log for this turn (Feature 4) ---
      const tokenData = {
        type: 'token_usage',
        group_folder: containerInput.groupFolder,
        model: sdkEnv['CLAUDE_MODEL'] || 'unknown',
        input_tokens: turnInputTokens,
        output_tokens: turnOutputTokens,
        cache_read_tokens: turnCacheReadTokens,
        cache_creation_tokens: turnCacheCreateTokens,
        session_id: newSessionId || sessionId,
        task_type: containerInput.isScheduledTask ? 'scheduled_task' : 'message',
        timestamp: new Date().toISOString(),
      };
      log('[TOKEN IPC] Writing token usage for turn: ' + JSON.stringify(tokenData));
      try {
        fs.mkdirSync(TOKEN_LOGS_DIR, { recursive: true });
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
        const filepath = path.join(TOKEN_LOGS_DIR, filename);
        const tempPath = `${filepath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(tokenData));
        fs.renameSync(tempPath, filepath);
        log(`[TOKEN IPC] Written to ${filepath}`);
      } catch (err) {
        log(`Failed to write token usage log: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Consecutive error guard
      if (consecutiveErrorCount >= MAX_CONSECUTIVE_ERRORS) {
        log(`Guard KILL: ${MAX_CONSECUTIVE_ERRORS} consecutive errors reached`);
        writeGuardAlert(`⛔ Agent stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors for group ${containerInput.groupFolder}. Please rephrase or try again.`);
        writeGuardLog('consecutive_error_limit', consecutiveErrorCount, totalTokens);
        guardTriggered = true;
        stream.end();
        break;
      }
    }
  }

  // Token usage is now written inside the result handler above

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, consecutiveErrors: ${consecutiveErrorCount}, tokens: ${totalInputTokens}in/${totalOutputTokens}out, guard: ${guardTriggered}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery, pendingModelSwitchMessage, killSessionRequested };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  // --- Dynamic Model Routing (Feature 1) ---
  const apiKey = containerInput.secrets?.['ANTHROPIC_API_KEY'];
  if (apiKey) {
    try {
      await loadModels(apiKey);
    } catch (err) {
      log(`Failed to load models, using SDK default: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log('No API key in secrets, using SDK default model');
  }

  // Prompt caching: handled at the API level by the Claude Code CLI.
  // Uses cache_control blocks on the Messages API automatically.
  // See: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  // DO NOT set env vars — the SDK does not read them.

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  let currentSessionModel: string | undefined;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  fs.mkdirSync(TOKEN_LOGS_DIR, { recursive: true });
  fs.mkdirSync(GUARD_LOGS_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      // Select model based on prompt content (Feature 1)
      const selectedModel = selectModel(prompt, { haiku: MODEL_HAIKU, sonnet: MODEL_SONNET, opus: MODEL_OPUS });
      if (selectedModel) {
        if (currentSessionModel && currentSessionModel !== selectedModel) {
          log(`Model changed (${currentSessionModel} → ${selectedModel}), starting fresh session`);
          sessionId = undefined;
          resumeAt = undefined;
          currentSessionModel = undefined;
        }
        sdkEnv['CLAUDE_MODEL'] = selectedModel;
        log(`Selected model: ${selectedModel} for prompt (${prompt.trim().split(/\s+/).length} words)`);
      }

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt, currentSessionModel);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
        currentSessionModel = sdkEnv['CLAUDE_MODEL'];
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      if (queryResult.killSessionRequested) {
        log('Session kill requested, resetting state');
        sessionId = undefined;
        resumeAt = undefined;
        currentSessionModel = undefined;
        writeOutput({ status: 'success', result: '\n*[Session manually killed/reset. Ready for your next query.]*' });

        log('Waiting for next IPC message after kill...');
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received, exiting');
          break;
        }
        log(`Got new message (${nextMessage.length} chars), starting new query`);
        prompt = nextMessage;
        continue;
      }

      if (queryResult.pendingModelSwitchMessage) {
        log('Pending model switch message detected, restarting loop immediately');
        prompt = queryResult.pendingModelSwitchMessage;
        continue;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
