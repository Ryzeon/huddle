/**
 * Escribir, borrar y leer en la carpeta de la sala.
 *
 * Todo cambio difunde el estado entero a la sala. Es lo que hace que el disco
 * de cada miembro se ponga al día sin que nadie lo pida, y por eso el estado
 * viaja completo: reconciliar deltas cuesta más código del que ahorra en una
 * carpeta de 500 archivos.
 */

import type {
  FolderDropMessage,
  FolderGetMessage,
  FolderPutMessage,
  FolderPutManyMessage,
} from '@huddle/protocol';
import type { Room } from '../../domain/room.js';
import type { RoomMember } from '../../domain/member.js';
import type { ClockPort, MemberChannelPort } from '../ports/member-channel.js';
import type { RoomNotifier } from '../state/room-notifier.js';

export interface WriteFolderDeps {
  notifier: RoomNotifier;
  clock: ClockPort;
  log: (message: string) => void;
}

export interface FolderCommand<M> {
  room: Room;
  /** El miembro entero: el tope de escrituras es suyo, no de su alias. */
  member: RoomMember;
  channel: MemberChannelPort;
  message: M;
}

export class WriteFolderHandler {
  constructor(private readonly deps: WriteFolderDeps) {}

  /** Devuelve `true` si la carpeta cambió y hay que persistirla. */
  put({ room, member, channel, message }: FolderCommand<FolderPutMessage>): boolean {
    if (!this.mayWrite(room, member, channel, message.id)) return false;

    const outcome = room.folder.put(
      message.path,
      message.text,
      member.alias,
      this.deps.clock.now(),
    );

    if (outcome.kind === 'full') {
      channel.send({ t: 'error', id: message.id, reason: 'bad_request', detail: outcome.detail });
      return false;
    }

    if (outcome.pruned.length > 0) {
      this.deps.log(
        `carpeta de #${room.code}: podadas ${outcome.pruned.length} nota(s) por falta de sitio`,
      );
    }

    this.deps.notifier.broadcastFolder(room);
    channel.send({ t: 'folder_ok', id: message.id, path: message.path });
    return true;
  }

  /**
   * Escribe un lote entero: un hueco de ráfaga, una difusión.
   *
   * Los que no quepan se cuentan, pero no tumban el lote: quien vacía un zip
   * de cincuenta archivos prefiere que entren cuarenta y ocho y saber cuáles
   * faltan, a que no entre ninguno.
   */
  putMany({ room, member, channel, message }: FolderCommand<FolderPutManyMessage>): boolean {
    if (!this.mayWrite(room, member, channel, message.id)) return false;

    const now = this.deps.clock.now();
    let escritos = 0;
    let detalle = '';

    for (const file of message.files) {
      const outcome = room.folder.put(file.path, file.text, member.alias, now);
      if (outcome.kind === 'full') detalle = outcome.detail;
      else escritos += 1;
    }

    if (escritos === 0) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'bad_request',
        detail: detalle || 'no entró ninguno',
      });
      return false;
    }

    this.deps.notifier.broadcastFolder(room);
    channel.send({
      t: 'folder_ok',
      id: message.id,
      path: message.files[0]?.path ?? '',
      count: escritos,
    });

    if (escritos < message.files.length) {
      this.deps.log(
        `carpeta de #${room.code}: entraron ${escritos} de ${message.files.length}`,
      );
    }
    return true;
  }

  drop({ room, member, channel, message }: FolderCommand<FolderDropMessage>): boolean {
    if (!this.mayWrite(room, member, channel, message.id)) return false;

    if (!room.folder.drop(message.path)) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'bad_request',
        detail: `en la carpeta no hay ningún "${message.path}"`,
      });
      return false;
    }

    this.deps.notifier.broadcastFolder(room);
    channel.send({ t: 'folder_ok', id: message.id, path: message.path });
    return true;
  }

  /** Leer no cambia nada, así que no difunde ni pide permiso de escritura. */
  get({ room, channel, message }: FolderCommand<FolderGetMessage>): void {
    const file = room.folder.read(message.path);
    if (!file) {
      channel.send({
        t: 'error',
        id: message.id,
        reason: 'bad_request',
        detail: `en la carpeta no hay ningún "${message.path}"`,
      });
      return;
    }

    channel.send({
      t: 'folder_file',
      id: message.id,
      path: file.path,
      text: file.text,
      at: file.at,
    });
  }

  private mayWrite(
    room: Room,
    member: RoomMember,
    channel: MemberChannelPort,
    id: string,
  ): boolean {
    if (!room.canWriteFolder(member.alias)) {
      channel.send({
        t: 'error',
        id,
        reason: 'denied_by_owner',
        detail: `en esta sala solo el anfitrión (${room.hostAlias ?? '—'}) escribe en la carpeta`,
      });
      return false;
    }

    // El tope va después del permiso: a quien no puede escribir no se le
    // gastan huecos por intentarlo.
    if (!room.allowFolderWrite(member, this.deps.clock.now())) {
      channel.send({
        t: 'error',
        id,
        reason: 'rate_limited',
        detail: 'demasiados cambios seguidos en la carpeta; espera un momento',
      });
      return false;
    }

    return true;
  }
}
