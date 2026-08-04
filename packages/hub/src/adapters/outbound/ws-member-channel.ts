import type { WebSocket } from 'ws';
import { encodeMessage, type ServerMessage } from '@huddle/protocol';
import type { MemberChannelPort } from '../../application/ports/member-channel.js';

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
