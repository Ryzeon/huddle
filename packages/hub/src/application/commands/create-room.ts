import { PROTOCOL_VERSION, normalizeAlias, type CreateRoomMessage } from '@huddle/protocol';
import type {
  ClockPort,
  MemberChannelPort,
  SignatureVerifierPort,
} from '../ports/member-channel.js';
import type { RoomRegistry } from '../state/room-registry.js';
import type { RoomNotifier } from '../state/room-notifier.js';
import type { Challenges } from '../state/challenges.js';
import { verifiedKey } from './verify-identity.js';

export interface CreateRoomCommand {
  channel: MemberChannelPort;
  message: CreateRoomMessage;
}

export interface CreateRoomDeps {
  registry: RoomRegistry;
  notifier: RoomNotifier;
  clock: ClockPort;
  challenges: Challenges;
  verifier: SignatureVerifierPort;
  generateCode: () => string;
  log: (message: string) => void;
}

const MAX_NAME_LENGTH = 64;

export class CreateRoomHandler {
  constructor(private readonly deps: CreateRoomDeps) {}

  handle({ channel, message }: CreateRoomCommand): void {
    if (message.v !== PROTOCOL_VERSION) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: `versión de protocolo ${message.v}, el hub habla ${PROTOCOL_VERSION}`,
      });
      channel.close(4002, 'protocol mismatch');
      return;
    }

    const name = message.name.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) {
      channel.send({
        t: 'error',
        id: '',
        reason: 'bad_request',
        detail: 'la sala necesita un nombre',
      });
      return;
    }

    const { registry, notifier, clock, challenges, verifier, log } = this.deps;
    const alias = normalizeAlias(message.alias);

    // La sala aún no tiene código, así que `create` firma con el campo vacío.
    // Lo que ata la firma aquí es el `kind`: no vale como `join` en ningún lado.
    const offered = verifiedKey(
      { challenges, verifier },
      {
        channelId: channel.id,
        proof: message.proof,
        context: { kind: 'create', room: '', alias, tag: message.tag },
      },
    );

    const room = registry.createRoom(name, this.deps.generateCode, clock.now());
    const verified = offered !== undefined && room.bindKey(alias, offered);

    // `validate` ya garantiza que no hay `approved` sin prueba; esto es la
    // segunda cerradura, por si algún día se entra por otra puerta.
    if (message.policy === 'approved' && offered) {
      room.restorePolicy('approved');
      room.restoreOwnerKey(offered);
    }

    room.join(
      {
        channelId: channel.id,
        alias,
        tag: message.tag,
        card: message.card,
        pubkey: verified ? offered : undefined,
        verified,
        lastSeen: clock.now(),
        quotaRemaining: message.quotaRemaining,
      },
      clock.now(),
    );
    registry.attach(channel, room.code);

    channel.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      room: room.code,
      roomName: room.name,
      you: alias,
      host: alias,
      members: room.roster(),
      verified,
    });
    notifier.broadcast(room, { t: 'host_changed', host: alias, reason: 'created' });

    log(`${alias} creó "${name}" → código ${room.code} (${room.policy})`);
  }
}
