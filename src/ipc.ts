import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  CHROMA_ENABLED,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getTaskById,
  updateTask,
  logGuardTrigger,
  logTokenUsage,
  upsertBusinessFact,
} from './db.js';
import { semanticSearch, isChromaAvailable } from './chromadb.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process guard logs from this group's IPC directory
      const guardLogsDir = path.join(ipcBaseDir, sourceGroup, 'guard_logs');
      try {
        if (fs.existsSync(guardLogsDir)) {
          const guardFiles = fs
            .readdirSync(guardLogsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of guardFiles) {
            const filePath = path.join(guardLogsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'guard_trigger') {
                const groupFolder = data.group_folder || sourceGroup;
                logGuardTrigger({
                  group_folder: groupFolder,
                  reason: data.reason,
                  turn_count: data.turn_count,
                  token_count: data.token_count,
                  task_type: data.task_type,
                });

                // Find the associated chatJid for this group folder to send the alert back
                const registeredGroups = deps.registeredGroups();
                let targetJid: string | undefined;
                // Try to find the chatJid that owns this folder
                for (const [jid, group] of Object.entries(registeredGroups)) {
                  if (group.folder === groupFolder) {
                    targetJid = jid;
                    break;
                  }
                }

                if (targetJid) {
                  const isSoftWarning = data.reason === 'token_budget_soft';
                  const alertMessage = isSoftWarning
                    ? `⚠️ *Token Budget Warning:* Usage at ${data.token_count} tokens (soft limit: 50,000). The session is still running but approaching the hard limit.`
                    : `🛑 *System Alert:* Agent session terminated automatically. Reason: ${data.reason}. Tokens: ${data.token_count}, Turns: ${data.turn_count}.`;
                  deps.sendMessage(targetJid, alertMessage).catch((err) => {
                    logger.error(
                      { err, targetJid },
                      'Failed to send guard trigger alert',
                    );
                  });
                } else {
                  logger.warn(
                    { groupFolder },
                    'Could not find target JID to send guard trigger alert',
                  );
                }

                logger.info(
                  {
                    reason: data.reason,
                    group: sourceGroup,
                    alerted: !!targetJid,
                  },
                  'Guard trigger logged and alerted',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing guard log',
              );
              fs.unlinkSync(filePath);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading guard logs directory',
        );
      }

      // Process token usage logs from this group's IPC directory
      const tokenLogsDir = path.join(ipcBaseDir, sourceGroup, 'token_logs');
      try {
        if (fs.existsSync(tokenLogsDir)) {
          const tokenFiles = fs
            .readdirSync(tokenLogsDir)
            .filter((f) => f.endsWith('.json'));
          if (tokenFiles.length > 0) {
            console.log(
              `[TOKEN IPC] Detected ${tokenFiles.length} token usage file(s) in ${tokenLogsDir}`,
            );
          }
          for (const file of tokenFiles) {
            console.log(`[TOKEN IPC] Processing token file: ${file}`);
            const filePath = path.join(tokenLogsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'token_usage') {
                logTokenUsage({
                  group_folder: data.group_folder || sourceGroup,
                  model: data.model || 'unknown',
                  input_tokens: data.input_tokens || 0,
                  output_tokens: data.output_tokens || 0,
                  cache_read_tokens: data.cache_read_tokens,
                  cache_creation_tokens: data.cache_creation_tokens,
                  session_id: data.session_id,
                  task_type: data.task_type,
                });
                logger.debug(
                  {
                    group: sourceGroup,
                    model: data.model,
                    input: data.input_tokens,
                    output: data.output_tokens,
                  },
                  'Token usage logged',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing token log',
              );
              fs.unlinkSync(filePath);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading token logs directory',
        );
      }

      // Process semantic search requests
      const searchRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'search_requests',
      );
      try {
        if (
          fs.existsSync(searchRequestsDir) &&
          CHROMA_ENABLED &&
          isChromaAvailable()
        ) {
          const searchFiles = fs
            .readdirSync(searchRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of searchFiles) {
            const filePath = path.join(searchRequestsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'semantic_search' && data.request_id) {
                const results = await semanticSearch(
                  data.query,
                  data.max_results || 5,
                );
                // Write results for the agent to read
                const resultsDir = path.join(
                  ipcBaseDir,
                  sourceGroup,
                  'search_results',
                );
                fs.mkdirSync(resultsDir, { recursive: true });
                const resultFile = path.join(
                  resultsDir,
                  `${data.request_id}.json`,
                );
                const tempPath = `${resultFile}.tmp`;
                fs.writeFileSync(tempPath, JSON.stringify({ results }));
                fs.renameSync(tempPath, resultFile);

                logger.debug(
                  {
                    group: sourceGroup,
                    query: data.query,
                    resultCount: results.length,
                  },
                  'Semantic search completed',
                );
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing search request',
              );
              fs.unlinkSync(filePath);
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading search requests directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      // Handle store_fact IPC for Tier 3 memory
      if (
        data.type === 'store_fact' &&
        'key' in data &&
        'value' in data &&
        'category' in data
      ) {
        const key = data.key as string;
        const value = data.value as string;
        const category = data.category as string;
        upsertBusinessFact(key, value, category);
        logger.info(
          { key, category, sourceGroup },
          'Business fact stored via IPC',
        );
        break;
      }
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
