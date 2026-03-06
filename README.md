<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>
Using Claude Code, NanoClaw can dynamically rewrite its code to customize its feature set for your needs.

**New:** First AI assistant to support [Agent Swarms](https://code.claude.com/docs/en/agent-teams). Spin up teams of agents that collaborate in your chat.

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Apple Container (macOS) or Docker (macOS/Linux)
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks. NanoClaw is the first personal AI assistant to support agent swarms.
- **Dynamic model routing** - Automatically selects Haiku, Sonnet, or Opus based on prompt complexity
- **Loop guards** - Turn and token budget limits prevent runaway sessions with WhatsApp alerts
- **Prompt caching** - Reduces API costs ~25-30% by caching system prompts and CLAUDE.md context
- **Token usage logging** - Every session's token consumption logged to SQLite for cost tracking
- **Smart polling schedule** - Time-of-day-aware message polling (fast by day, slow overnight)
- **4-tier memory** - Active context → per-contact history → business facts → semantic vector search
- **Senri CRM** - 10 MCP tools for customers, visits, transactions, products, inventory, and reminders
- **Microsoft 365** - Teams, Outlook, and SharePoint access via MS365 MCP HTTP server
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Custom Features

### Dynamic Model Routing

On startup, the agent runner fetches all available models from the Anthropic API via `client.models.list()` and dynamically resolves the latest Haiku, Sonnet, and Opus model IDs — no hardcoded model names. Each prompt is then routed to the best-fit model.

**Routing logic (evaluated top to bottom, first match wins):**

| Priority | Rule | Model Selected |
|----------|------|---------------|
| 1 — Direct override | Prompt contains the word **`haiku`** | → Haiku |
| 2 — Direct override | Prompt contains the word **`opus`** | → Opus |
| 3 — Direct override | Prompt contains the word **`sonnet`** | → Sonnet |
| 4 — Short prompt | Prompt is **under 15 words** | → Haiku |
| 5 — Triage keywords | Prompt contains: `triage`, `classify`, `status`, `lookup`, `yes/no` | → Haiku |
| 6 — High-priority keywords | Prompt contains: `important`, `urgent`, `decision`, `strategy`, `meeting recording`, `external email` | → Opus |
| 7 — Default | Everything else | → Sonnet |

**Examples:**

```
"what's the status of the build?"          → Haiku  (keyword: status)
"yes"                                      → Haiku  (under 15 words)
"use haiku to summarize this document"     → Haiku  (direct override: haiku)
"this is urgent, review the contract"      → Opus   (keyword: urgent)
"use opus to draft the strategy doc"       → Opus   (direct override: opus)
"draft a reply to Sarah's email"           → Sonnet (default, no keyword match)
```

The selected model is passed to the SDK via the `CLAUDE_MODEL` environment variable. Model IDs are logged at startup and on each query so you can verify which model handled each request. If a requested model tier (e.g., Opus) isn't available on your API key, it falls back to Sonnet.

### Loop Guards

Prevents runaway sessions that burn through your API budget:

- **Container timeout (90s default)** — host-level watchdog that kills the Docker container if it produces zero stdout for the configured `CONTAINER_TIMEOUT` duration. Resets on every output chunk, so actively streaming agents are never affected. Catches genuinely frozen/unresponsive containers
- **Consecutive error cap (8)** — if the agent produces 8 consecutive SDK-level errors without a single success, the session is killed. Any successful result resets the counter to 0
- **Token soft limit (50k)** — sends a ⚠️ warning alert to the active chat. The session continues running
- **Token hard limit (100k)** — sends a 🛑 kill alert and terminates the session immediately

Error subtypes tracked: `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.

All guard triggers are:
1. Sent as WhatsApp/chat alerts — soft limit warnings use ⚠️ and note the session is still running; hard kills use 🛑 and confirm termination
2. Logged to the `guard_logs` SQLite table with timestamp, reason, turn/token counts, and task type

### Prompt Caching

Enabled automatically via `CLAUDE_CODE_PROMPT_CACHING=1`. The Anthropic API caches the system prompt and CLAUDE.md context across requests, targeting 25-30% cost reduction on repeated interactions with the same group.

Cache read and creation tokens are tracked separately in the token usage logs so you can measure actual savings.

### Token Usage Logging

Every agent session writes a token usage record to the `token_usage` SQLite table:

| Column | Description |
|--------|-------------|
| `timestamp` | When the session ended |
| `group_folder` | Which group ran the query |
| `model` | Model ID used (e.g., `claude-sonnet-4-20250514`) |
| `input_tokens` | Total input tokens consumed |
| `output_tokens` | Total output tokens consumed |
| `cache_read_tokens` | Tokens served from prompt cache |
| `cache_creation_tokens` | Tokens used to create cache entries |
| `session_id` | Agent session identifier |
| `task_type` | `message` or `scheduled_task` |

Query your costs:
```sql
SELECT group_folder, model, SUM(input_tokens) as total_in, SUM(output_tokens) as total_out
FROM token_usage
GROUP BY group_folder, model
ORDER BY total_out DESC;
```

### Smart Polling Schedule

Time-of-day-aware polling frequency that reduces unnecessary API calls during off-hours:

| Period | Hours | Polling Interval |
|--------|-------|------------------|
| Daytime | 7am – 8pm | Every 5 minutes |
| Evening | 8pm – 11pm | Every 30 minutes |
| Overnight | 11pm – 7am | Every 2 hours |

Disabled by default. Enable with `SMART_POLLING_ENABLED=true` in `.env`. All intervals are configurable via `DAYTIME_POLL_INTERVAL`, `EVENING_POLL_INTERVAL`, and `OVERNIGHT_POLL_INTERVAL` (in milliseconds). Uses the configured `TZ` timezone.

Designed as a pluggable framework — future channels (Teams, Outlook, etc.) will integrate directly with this scheduler.

### 4-Tier Memory Architecture

| Tier | Storage | What It Holds | How Agents Access It |
|------|---------|---------------|---------------------|
| 1 — Active Context | Claude's context window | Current conversation | Automatic (native) |
| 2 — Per-Contact History | `messages` SQLite table | Full message history per chat | Loaded into prompts by the orchestrator |
| 3 — Business Facts | `business_facts` SQLite table | Persistent key-value facts organized by category | MCP tools: `store_business_fact`, `get_business_facts`, `search_business_facts` |
| 4 — Semantic Search | ChromaDB vector store (Docker service) | Chunked + embedded conversations, transcripts, digests | MCP tool: `semantic_search` |

**Tier 3 — Business Facts** allow agents to remember structured information across sessions. Facts are organized by category (`contact`, `process`, `preference`, `reference`, `general`) and persist in SQLite. A snapshot is written to each container's IPC directory before every agent run.

**Tier 4 — Semantic Search** uses ChromaDB with built-in embeddings (no external API needed). Conversations are automatically chunked, embedded, and stored. Agents can search using natural language queries like *"What did we discuss about the marketing budget?"*

To enable Tier 4, set `CHROMA_ENABLED=true` and start ChromaDB:
```bash
docker compose up -d chromadb
```
## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram alongside WhatsApp. Instead, contribute a skill file (`.claude/skills/add-telegram/SKILL.md`) that teaches Claude Code how to transform a NanoClaw installation to use Telegram.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

**Session Management**
- `/clear` - Add a `/clear` command that compacts the conversation (summarizes context while preserving critical information in the same session). Requires figuring out how to trigger compaction programmatically via the Claude Agent SDK.

## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
                          |                    |
                          |                    +--> Model Router (Haiku/Sonnet/Opus)
                          |                    +--> Loop Guards (turn + token limits)
                          |                    +--> Token Logger --> IPC --> SQLite
                          |                    +--> MCP Tools (facts, search, tasks, Senri CRM)
                          |                    +--> MS365 MCP (Teams, Outlook, SharePoint)
                          |
                     Smart Polling
                   (time-of-day aware)
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Bash access is safe because commands run inside the container, not on your host. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see [docs/SPEC.md](docs/SPEC.md).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation, ChromaDB init, smart polling
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher: messages, tasks, guard logs, token logs, facts, semantic search
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers, writes fact snapshots
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state, token usage, guard logs, business facts)
- `src/polling-scheduler.ts` - Time-of-day-aware polling intervals
- `src/chromadb.ts` - ChromaDB vector store client (Tier 4 memory)
- `src/config.ts` - All configuration constants from environment
- `container/agent-runner/src/index.ts` - Agent entry point: loop guards, prompt caching, token logging
- `container/agent-runner/src/router.ts` - Model routing logic (selectModel): Haiku/Sonnet/Opus selection rules
- `container/agent-runner/src/ipc-mcp-stdio.ts` - MCP tools exposed to agents (send_message, tasks, facts, search, Senri CRM)
- `container/agent-runner/src/senri.ts` - Senri CRM API client (token cache, senriGet helper)
- `groups/*/CLAUDE.md` - Per-group memory
- `docker-compose.yml` - ChromaDB service for Tier 4 memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime.

**Can I run this on Linux?**

Yes. Docker is the default runtime and works on both macOS and Linux. Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. You should still review what you're running, but the codebase is small enough that you actually can. See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**What environment variables are available?**

```bash
# Core
ASSISTANT_NAME=Andy              # Trigger name for the bot
ANTHROPIC_API_KEY=sk-ant-...     # Required for model access

# Container
CONTAINER_IMAGE=nanoclaw-agent:latest
CONTAINER_TIMEOUT=90000          # 90s silence watchdog (kills frozen containers)
IDLE_TIMEOUT=1800000             # 30 min idle before container exit
MAX_CONCURRENT_CONTAINERS=5

# Timezone
TZ=Asia/Kolkata

# Smart Polling (optional, disabled by default)
SMART_POLLING_ENABLED=false
DAYTIME_POLL_INTERVAL=300000     # 5 min (7am-8pm)
EVENING_POLL_INTERVAL=1800000    # 30 min (8pm-11pm)
OVERNIGHT_POLL_INTERVAL=7200000  # 2 hrs (11pm-7am)

# ChromaDB / Tier 4 Memory (optional, disabled by default)
CHROMA_ENABLED=false
CHROMA_HOST=http://localhost
CHROMA_PORT=8000

# Senri CRM (optional — set both to enable 10 Senri tools)
SENRI_API_KEY=
SENRI_API_SECRET=

# Microsoft 365 (optional — requires MS365 MCP HTTP server on host)
MS365_ENABLED=false

# Third-party model endpoints (optional)
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Project Status

| Feature | Status |
|---------|--------|
| Multi-model routing (Haiku/Sonnet/Opus) | ✅ Implemented and tested |
| Smart polling schedule | ✅ Implemented and tested |
| Loop guards (timeout + error cap + token budget) | ✅ Implemented and tested |
| WhatsApp alerts on guard triggers | ✅ Implemented and tested |
| Prompt caching | ✅ Enabled (native Anthropic API) |
| Token usage logging to SQLite | ✅ Implemented and tested |
| 4-tier memory architecture | ✅ Implemented and tested (17 tests) |
| Senri CRM integration (10 tools) | ✅ Implemented and tested (10 tests) |
| Microsoft Teams / Outlook / SharePoint (MS365 MCP) | ✅ Implemented (requires host-side MS365 server) |
| Voice note transcription (mlx-whisper) | 🔜 Planned |

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and migration notes.

## License

MIT
