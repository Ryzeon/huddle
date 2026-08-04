import type { WebSocket } from 'ws';
import { encodeMessage, type ServerMessage } from '@huddle/protocol';
import type { MemberChannelPort } from '../../application/ports/member-channel.js';

/**
 * Adaptador de salida: implementa `MemberChannelPort` sobre un WebSocket.
 *
 * Todo lo específico de `ws` (readyState, serialización) queda aquí; el
 * servicio de aplicación solo sabe `send` y `close`.
 */
export class WsMemberChannel implements MemberChannelPort {
  readonly id: string;
  private readonly socket: WebSocket;

  constructor(id: string, socket: WebSocket) {
    this.id = id;
    this.socket = socket;
  }

  send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(encodeMessage(message));
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
}
