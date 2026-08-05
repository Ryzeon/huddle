import { SOCKET_PATH, loadConfig } from '../../../config.js';
import { buildAgent } from '../../../composition/container.js';
import { callControl, startControlServer } from '../control-server.js';
import { addWorkspaceToConfig, removeWorkspaceFromConfig } from './workspaces.js';

type Agent = ReturnType<typeof buildAgent>;

export async function runStop(): Promise<void> {
  try {
    await callControl({ op: 'shutdown' });
    console.log('Daemon detenido.');
  } catch {
    console.log('No había ningún daemon corriendo.');
  }
}

export function runDaemon(): void {
  serveControl(buildAgent(loadConfig()));
}

export function serveControl(agent: Agent, alreadyStarted = false): void {
  const control: { close: () => void } = startControlServer({
    ask: (to, question, ttl) => agent.ask(to as never, question, ttl),
    status: () => agent.status(),
    members: () => agent.members(),
    kick: (alias, reason) => {
      agent.kickMember(alias, reason);
      return { ok: true };
    },
    // Config y estado vivo se actualizan juntos: si solo se guardara el
    // archivo, lo que corre y lo que está escrito quedarían desincronizados
    // hasta el próximo reinicio.
    addRepo: (path, tag) => {
      const added = addWorkspaceToConfig(path, tag);
      return agent.addWorkspace(added);
    },
    removeRepo: (tag) => {
      const result = removeWorkspaceFromConfig(tag);
      agent.removeWorkspace(tag);
      return result;
    },
    repos: () => loadConfig().workspaces,
    closeRoom: (reason) => {
      agent.closeRoom(reason);
      return { ok: true };
    },
    rotateCode: async (reason) => ({ room: await agent.rotateCode(reason) }),
    pending: () => agent.pending(),
    admit: (id, remember) => {
      agent.admit(id, remember);
      return { ok: true };
    },
    deny: (id, reason) => {
      agent.deny(id, reason);
      return { ok: true };
    },
    folderList: () => ({ dir: agent.folderDir, files: agent.folder() }),
    folderRead: (path) => agent.readFile(path).then((text) => ({ path, text })),
    folderWrite: (path, text) => agent.writeFile(path, text),
    folderRemove: (path) => agent.removeFile(path),
    // Se contesta primero y se sale después: si saliéramos aquí, quien lo
    // pidió no llegaría a saber que funcionó.
    shutdown: () => {
      setTimeout(() => {
        agent.stop();
        control.close();
        process.exit(0);
      }, 100).unref();
      return { stopping: true };
    },
  });

  if (!alreadyStarted) agent.start();
  console.log(`socket de control en ${SOCKET_PATH}`);

  const shutdown = (): void => {
    console.log('\ncerrando…');
    agent.stop();
    control.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
