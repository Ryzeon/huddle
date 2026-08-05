import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Quota } from '../domain/quota.js';
import { createMemoryQuotaStore } from '../adapters/outbound/fs-stores.js';
import { AgentService, WorkspaceAgent } from './agent-service.js';
import type { LoggerPort, RoomGatewayPort, RoomInfo } from './ports/index.js';

class FakeGateway implements RoomGatewayPort {
  rotations: (string | undefined)[] = [];
  used: string[] = [];
  nextCode = 'NUEVO-CODIG';
  rotationFails?: string;

  connect(): void {}
  create(): Promise<string> {
    return Promise.resolve('VIEJO-CODIG');
  }
  kick(): void {}
  admitted: { id: string; remember?: boolean }[] = [];
  denied: string[] = [];
  admit(id: string, remember?: boolean): void {
    this.admitted.push({ id, remember });
  }
  deny(id: string): void {
    this.denied.push(id);
  }
  closeRoom(): void {}
  rotateCode(reason?: string): Promise<string> {
    this.rotations.push(reason);
    if (this.rotationFails) return Promise.reject(new Error(this.rotationFails));
    return Promise.resolve(this.nextCode);
  }
  useRoomCode(code: string): void {
    this.used.push(code);
  }
  room(): RoomInfo | undefined {
    return undefined;
  }
  disconnect(): void {}
  isConnected(): boolean {
    return true;
  }
  announcePresence(): void {}
  sendChunk(): void {}
  sendTrace(): void {}
  sendAnswer(): void {}
  sendFailure(): void {}
  ask(): Promise<never> {
    throw new Error('no se usa');
  }
  roster(): [] {
    return [];
  }
}

const silent: LoggerPort = { info: () => undefined, warn: () => undefined };

function workspaceWith(gateway: FakeGateway, tag?: string): WorkspaceAgent {
  return new WorkspaceAgent({
    tag,
    room: gateway,
    repo: {
      snapshot: () => ({ repo: 'repo', dirs: [] }),
      currentSha: () => undefined,
      currentBranch: () => undefined,
    },
    cache: { size: 0 } as never,
    answerQuestion: { execute: () => Promise.resolve() } as never,
    state: {},
    logger: silent,
  });
}

describe('cambiar el código desde el agente', () => {
  let principal: FakeGateway;
  let secundario: FakeGateway;
  let guardados: string[];
  let agent: AgentService;

  beforeEach(() => {
    principal = new FakeGateway();
    secundario = new FakeGateway();
    guardados = [];
    agent = new AgentService(
      {
        workspaces: [workspaceWith(principal), workspaceWith(secundario, 'api')],
        quota: new Quota(null, 1, { store: createMemoryQuotaStore() }),
        logger: silent,
        onCodeRotated: (code) => guardados.push(code),
      },
      { room: 'VIEJO-CODIG', alias: '@ana', hub: 'ws://localhost:8787' },
    );
  });

  test('la rotación va por el repositorio principal', async () => {
    await agent.rotateCode('se filtró');

    assert.deepEqual(principal.rotations, ['se filtró']);
    assert.deepEqual(secundario.rotations, [], 'el hub solo acepta rotar al anfitrión');
  });

  test('el código nuevo llega a todos los demás repositorios', async () => {
    await agent.rotateCode();

    assert.deepEqual(
      secundario.used,
      ['NUEVO-CODIG'],
      'acaban de quedarse fuera; sin esto reconectan con el código muerto',
    );
  });

  test('el código nuevo se guarda para el próximo arranque', async () => {
    await agent.rotateCode();
    assert.deepEqual(guardados, ['NUEVO-CODIG']);
  });

  test('el estado del agente pasa a decir el código nuevo', async () => {
    assert.equal(agent.status().room, 'VIEJO-CODIG');
    await agent.rotateCode();
    assert.equal(agent.status().room, 'NUEVO-CODIG');
  });

  test('si el hub la rechaza, no se guarda ni se reparte nada', async () => {
    principal.rotationFails = 'denied_by_owner: solo el anfitrión puede cambiar el código';

    await assert.rejects(() => agent.rotateCode(), /denied_by_owner/);

    assert.deepEqual(guardados, []);
    assert.deepEqual(secundario.used, []);
    assert.equal(agent.status().room, 'VIEJO-CODIG');
  });

  test('sin repositorios configurados no hay sala que rotar', async () => {
    const vacio = new AgentService(
      {
        workspaces: [],
        quota: new Quota(null, 1, { store: createMemoryQuotaStore() }),
        logger: silent,
      },
      { room: 'X', alias: '@ana', hub: 'ws://x' },
    );

    await assert.rejects(() => vacio.rotateCode(), /repositorio/);
  });
});
