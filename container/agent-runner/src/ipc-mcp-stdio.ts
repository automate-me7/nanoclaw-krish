/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Tier 3: Business Facts ---

const FACTS_SNAPSHOT_FILE = path.join(IPC_DIR, 'business_facts.json');

server.tool(
  'store_business_fact',
  `Store or update a business fact in long-term memory. Facts persist across sessions.
  
Use categories to organize facts:
• "contact" — names, roles, companies, preferences
• "process" — how things work, SOPs, policies
• "preference" — user/team preferences and settings
• "reference" — API keys, URLs, account numbers
• "general" — anything else

Examples:
• key="ceo_name", value="Jane Smith", category="contact"
• key="crm_url", value="https://crm.example.com", category="reference"`,
  {
    key: z.string().describe('Unique identifier for the fact (e.g., "ceo_name", "crm_url")'),
    value: z.string().describe('The fact value'),
    category: z.string().describe('Category: contact, process, preference, reference, or general'),
  },
  async (args) => {
    const data = {
      type: 'store_fact',
      key: args.key,
      value: args.value,
      category: args.category,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Fact stored: ${args.key} = ${args.value} (${args.category})` }],
    };
  },
);

server.tool(
  'get_business_facts',
  'Retrieve stored business facts from long-term memory. Returns all facts, optionally filtered by category.',
  {
    category: z.string().optional().describe('Filter by category (e.g., "contact", "process")'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(FACTS_SNAPSHOT_FILE)) {
        return { content: [{ type: 'text' as const, text: 'No business facts stored yet.' }] };
      }

      const allFacts = JSON.parse(fs.readFileSync(FACTS_SNAPSHOT_FILE, 'utf-8'));
      const filtered = args.category
        ? allFacts.filter((f: { category: string }) => f.category === args.category)
        : allFacts;

      if (filtered.length === 0) {
        return { content: [{ type: 'text' as const, text: args.category ? `No facts in category "${args.category}".` : 'No business facts stored yet.' }] };
      }

      const formatted = filtered
        .map((f: { key: string; value: string; category: string; updated_at: string }) =>
          `• [${f.category}] ${f.key}: ${f.value} (updated: ${f.updated_at})`)
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Business facts:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading facts: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'search_business_facts',
  'Search business facts by keyword. Searches across keys, values, and categories.',
  {
    query: z.string().describe('Search term to find in fact keys, values, or categories'),
  },
  async (args) => {
    try {
      if (!fs.existsSync(FACTS_SNAPSHOT_FILE)) {
        return { content: [{ type: 'text' as const, text: 'No business facts stored yet.' }] };
      }

      const allFacts = JSON.parse(fs.readFileSync(FACTS_SNAPSHOT_FILE, 'utf-8'));
      const lower = args.query.toLowerCase();
      const matches = allFacts.filter(
        (f: { key: string; value: string; category: string }) =>
          f.key.toLowerCase().includes(lower) ||
          f.value.toLowerCase().includes(lower) ||
          f.category.toLowerCase().includes(lower),
      );

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `No facts matching "${args.query}".` }] };
      }

      const formatted = matches
        .map((f: { key: string; value: string; category: string }) =>
          `• [${f.category}] ${f.key}: ${f.value}`)
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Search results for "${args.query}":\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error searching facts: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// --- Tier 4: Semantic Search (ChromaDB) ---

const SEARCH_RESULTS_DIR = path.join(IPC_DIR, 'search_results');
const SEARCH_REQUESTS_DIR = path.join(IPC_DIR, 'search_requests');

server.tool(
  'semantic_search',
  `Search your long-term memory using natural language. This searches across past conversations, voice transcripts, and daily digests using semantic similarity.
  
Use this when you need to recall past discussions, find relevant context, or look up information from previous interactions.

Example queries:
• "What did we discuss about the marketing budget?"
• "Meeting notes from last week"
• "User's preferred communication style"`,
  {
    query: z.string().describe('Natural language search query'),
    max_results: z.number().optional().default(5).describe('Maximum number of results (default: 5)'),
  },
  async (args) => {
    try {
      // Write search request for the host to process
      fs.mkdirSync(SEARCH_REQUESTS_DIR, { recursive: true });
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestFile = path.join(SEARCH_REQUESTS_DIR, `${requestId}.json`);
      const requestTempPath = `${requestFile}.tmp`;
      fs.writeFileSync(requestTempPath, JSON.stringify({
        type: 'semantic_search',
        query: args.query,
        max_results: args.max_results || 5,
        group_folder: groupFolder,
        request_id: requestId,
        timestamp: new Date().toISOString(),
      }));
      fs.renameSync(requestTempPath, requestFile);

      // Wait for results (poll with timeout)
      const resultFile = path.join(SEARCH_RESULTS_DIR, `${requestId}.json`);
      fs.mkdirSync(SEARCH_RESULTS_DIR, { recursive: true });
      const maxWait = 10000; // 10 seconds
      const pollInterval = 200;
      let waited = 0;

      while (waited < maxWait) {
        if (fs.existsSync(resultFile)) {
          const results = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);

          if (!results.results || results.results.length === 0) {
            return { content: [{ type: 'text' as const, text: `No results found for "${args.query}".` }] };
          }

          const formatted = results.results
            .map((r: { document: string; metadata: Record<string, string>; distance: number }, i: number) =>
              `--- Result ${i + 1} (relevance: ${(1 - r.distance).toFixed(2)}) ---\nSource: ${r.metadata?.source || 'unknown'} | Group: ${r.metadata?.group_folder || 'unknown'} | Date: ${r.metadata?.timestamp || 'unknown'}\n${r.document}`)
            .join('\n\n');

          return { content: [{ type: 'text' as const, text: `Memory search results for "${args.query}":\n\n${formatted}` }] };
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        waited += pollInterval;
      }

      return { content: [{ type: 'text' as const, text: `Semantic search timed out. The memory store may not be available.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error during semantic search: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// --- Senri CRM Integration ---

import { initSenri, senriGet, isSenriConfigured } from './senri.js';

if (process.env.SENRI_API_KEY && process.env.SENRI_API_SECRET) {
  initSenri(process.env.SENRI_API_KEY, process.env.SENRI_API_SECRET);
}

server.tool(
  'senri_get_customers',
  'Get a list of customers (retailers) from Senri CRM. Returns id, name, code, region, tier, telephone, location, and status.',
  {
    updated_at_gteq: z.string().optional().describe('Filter by last updated date (e.g., "20240101")'),
    page: z.number().optional().describe('Page number for pagination'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/sage/retailers', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_search_customer',
  'Search for a specific customer in Senri CRM by code, external key, or approval status.',
  {
    code: z.string().optional().describe('Customer code'),
    external_unique_key: z.string().optional().describe('ERP external key'),
    manager_status: z.number().optional().describe('1=Approved, 2=Declined, 3=Pending'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/sage/retailers/search', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_users',
  'Get sales team users from Senri CRM. Returns id, name, code, role (manager/staff), status, and user groups.',
  {
    page: z.number().optional().describe('Page number'),
    status: z.number().optional().describe('1=active (default)'),
    updated_after: z.string().optional().describe('Filter by update date (e.g., "2024-01-01")'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/open_api/v1/users', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_visit_reports',
  'Get visit reports from Senri CRM. Includes answers, photos, actions, retailer, and user details.',
  {
    start_date: z.string().describe('Start date (YYYY-MM-DD, required)'),
    end_date: z.string().describe('End date (YYYY-MM-DD, required)'),
    user_id: z.number().optional().describe('Filter by user ID'),
    retailer_id: z.number().optional().describe('Filter by retailer ID'),
    page: z.number().optional().describe('Page number'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/open_api/v1/visit_reports', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_visits',
  'Get check-in/check-out visit records from Senri CRM. Includes user, retailer, timestamps, closeness, and visit result.',
  {
    start_date: z.string().describe('Start date (YYYY-MM-DD, required)'),
    end_date: z.string().describe('End date (YYYY-MM-DD, required)'),
    page: z.number().optional().describe('Page number'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/open_api/v1/visits', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_reminders',
  'Get scheduled visit reminders from Senri CRM. Includes user, retailer, datetime, note, objectives, and status.',
  {
    start_date: z.string().describe('Start date (YYYY-MM-DD, required)'),
    end_date: z.string().describe('End date (YYYY-MM-DD, required)'),
    page: z.number().optional().describe('Page number'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/open_api/v1/reminders', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_transactions',
  'Get trade/transaction records from Senri CRM. Includes deals, payments, deliveries, retailer, totals, and statuses.',
  {
    created_at_gteq: z.string().optional().describe('Created after date (e.g., "20240101")'),
    created_at_lteq: z.string().optional().describe('Created before date (e.g., "20240201")'),
    page: z.number().optional().describe('Page number'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/v1/erp/trades', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_search_transaction',
  'Search for a specific transaction in Senri CRM by invoice number or trade number.',
  {
    invoice_number: z.string().optional().describe('Invoice number to search'),
    trade_number: z.string().optional().describe('Trade number to search'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/v1/erp/trades/search', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_products',
  'Get products from Senri CRM. Returns id, code, name, category, unit, price tiers, and status.',
  {
    updated_at_gteq: z.string().optional().describe('Filter by last updated date (e.g., "20240101")'),
  },
  async (args) => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/sage/products', args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

server.tool(
  'senri_get_inventory',
  'Get main inventory list from Senri CRM. Returns inventory locations (use inventory ID to get per-product stock contents).',
  {},
  async () => {
    if (!isSenriConfigured()) {
      return { content: [{ type: 'text' as const, text: 'Senri CRM not configured. Set SENRI_API_KEY and SENRI_API_SECRET in .env.' }], isError: true };
    }
    try {
      const result = await senriGet('/api/external/v1/erp/main_inventories');
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Senri error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
