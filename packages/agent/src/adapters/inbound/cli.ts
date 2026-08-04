#!/usr/bin/env node

import { runMcpServer } from './mcp-server.js';
import { runDaemon } from './cli/daemon.js';
import { usage } from './cli/io.js';
import { runAsk, runQuery } from './cli/queries.js';
import { runAddRepo, runJoin, runListRepos, runRemoveRepo } from './cli/repos.js';
import { runClose, runCreate, runKick } from './cli/rooms.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'create':
      return runCreate(args);
    case 'join':
      return runJoin(args);
    case 'kick':
      return runKick(args);
    case 'close':
      return runClose(args);
    case 'add-repo':
      return runAddRepo(args);
    case 'remove-repo':
      return runRemoveRepo(args);
    case 'repos':
      return runListRepos();
    case 'daemon':
      return runDaemon();
    case 'mcp':
      return runMcpServer();
    case 'ask':
      return runAsk(args);
    case 'who':
      return runQuery('members');
    case 'status':
      return runQuery('status');
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
