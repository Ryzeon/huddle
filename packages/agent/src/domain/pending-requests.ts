export interface PendingRequest {
  id: string;
  alias: string;
  tag?: string;
  key: string;
  repo?: string;
  at: number;
  knownAlias?: string;
}

/**
 * Las solicitudes de entrada que este agente ha visto.
 *
 * Se deduplica por id porque cada repositorio tiene su propia conexión al hub,
 * y el anfitrión con tres repos recibe la misma solicitud tres veces. Sin
 * esto, `huddle pending` enseña a la misma persona tres veces y parece que hay
 * tres esperando.
 */
export class PendingRequests {
  private readonly byId = new Map<string, PendingRequest>();

  add(request: PendingRequest): void {
    this.byId.set(request.id, request);
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  list(): PendingRequest[] {
    return [...this.byId.values()].sort((a, b) => a.at - b.at);
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}
