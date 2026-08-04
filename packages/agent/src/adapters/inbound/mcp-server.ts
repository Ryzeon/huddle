import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { callControl, DaemonNotRunningError } from './control-server.js';
import { ensureDaemonRunning } from './daemon-launcher.js';

async function withDaemon<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof DaemonNotRunningError)) throw error;
    await ensureDaemonRunning();
    return operation();
  }
}

interface AskArgs {
  to?: unknown;
  question?: unknown;
  ttl?: unknown;
}

const TOOLS = [
  {
    name: 'room_ask',
    description:
      'Pregúntale al agente de un compañero de equipo sobre SU repositorio. ' +
      'Úsalo cuando la respuesta depende de código, decisiones o contexto que ' +
      'viven en la máquina de otra persona y no en este repo. ' +
      'Destinos: un alias concreto ("@ryzeon"), "@all" para preguntarle a ' +
      'toda la sala, o "@auto" para que el hub elija a quien mejor encaje. ' +
      'Tarda entre 5 y 60 segundos: no lo llames para cosas que puedes ' +
      'contestar leyendo el repositorio actual.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Alias destino (@alguien), "@all" o "@auto".',
        },
        question: {
          type: 'string',
          description:
            'La pregunta, autocontenida. Quien responde no ve esta conversación, ' +
            'así que incluye el contexto necesario para entenderla sola.',
        },
        ttl: {
          type: 'integer',
          description: 'Segundos de espera antes de rendirse (por defecto 120).',
        },
      },
      required: ['to', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_who',
    description:
      'Lista quién está en la sala ahora mismo, con el repositorio que expone ' +
      'cada uno y cuánta cuota le queda. Llámalo antes de room_ask si no sabes ' +
      'a quién preguntarle.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'room_add_repo',
    description:
      'Expone otro repositorio del usuario en la sala, para que sus compañeros ' +
      'puedan preguntarle también sobre ese código. Surte efecto al instante: ' +
      'no hace falta reiniciar nada. Comparte la MISMA cuota diaria que los ' +
      'demás repositorios, porque la cuota es de la suscripción de la persona. ' +
      'Úsalo cuando el usuario diga que quiere compartir o exponer otro proyecto.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Ruta absoluta del repositorio a exponer.',
        },
        tag: {
          type: 'string',
          description:
            'Etiqueta opcional para distinguirlo (@alias:etiqueta). Si se omite ' +
            'se deriva del nombre de la carpeta, que suele bastar.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_remove_repo',
    description:
      'Deja de exponer un repositorio en la sala. Surte efecto al instante. ' +
      'Necesita la etiqueta, que puedes consultar con room_repos.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Etiqueta del repositorio a retirar.' },
      },
      required: ['tag'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_repos',
    description:
      'Lista los repositorios que el usuario expone ahora mismo, con su ' +
      'etiqueta y su ruta. Úsalo antes de room_remove_repo, o cuando el ' +
      'usuario pregunte qué está compartiendo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'room_kick',
    description:
      'Expulsa a alguien de la sala. Solo funciona si el usuario es el ' +
      'anfitrión; si no, el hub lo rechaza. Echa todos los repositorios de esa ' +
      'persona a la vez. Es una acción brusca: confírmala con el usuario antes.',
    inputSchema: {
      type: 'object',
      properties: {
        alias: { type: 'string', description: 'Alias a expulsar, con @.' },
        reason: { type: 'string', description: 'Motivo, que se le muestra.' },
      },
      required: ['alias'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_status',
    description:
      'Estado de tu propio agente: conexión, sala, cuota que te queda hoy y ' +
      'preguntas en curso.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const;

function textResult(payload: unknown, isError = false) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    isError,
  };
}

export async function runMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'huddle', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS as unknown as [] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'room_ask': {
          const a = (args ?? {}) as AskArgs;
          if (typeof a.to !== 'string' || typeof a.question !== 'string') {
            return textResult('room_ask necesita `to` y `question` como strings.', true);
          }
          // A constantes locales: dentro del closure TypeScript pierde el
          // estrechamiento que dio el `typeof` de arriba.
          const to = a.to;
          const question = a.question;
          const ttl = typeof a.ttl === 'number' ? Math.min(Math.max(a.ttl, 10), 300) : 120;

          const res = await withDaemon(() => callControl({ op: 'ask', to, question, ttl }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_who': {
          const res = await withDaemon(() => callControl({ op: 'members' }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_add_repo': {
          const a = (args ?? {}) as { path?: unknown; tag?: unknown };
          if (typeof a.path !== 'string') {
            return textResult('room_add_repo necesita `path` como string.', true);
          }
          const path = a.path;
          const tag = typeof a.tag === 'string' ? a.tag : undefined;
          const res = await withDaemon(() => callControl({ op: 'add_repo', path, tag }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_remove_repo': {
          const a = (args ?? {}) as { tag?: unknown };
          if (typeof a.tag !== 'string') {
            return textResult('room_remove_repo necesita `tag` como string.', true);
          }
          const tag = a.tag;
          const res = await withDaemon(() => callControl({ op: 'remove_repo', tag }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_repos': {
          const res = await withDaemon(() => callControl({ op: 'repos' }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_kick': {
          const a = (args ?? {}) as { alias?: unknown; reason?: unknown };
          if (typeof a.alias !== 'string') {
            return textResult('room_kick necesita `alias` como string.', true);
          }
          const alias = a.alias;
          const reason = typeof a.reason === 'string' ? a.reason : undefined;
          const res = await withDaemon(() => callControl({ op: 'kick', alias, reason }));
          if (!res.ok) return textResult(res.error, true);
          return textResult({ ok: true, mensaje: `Expulsado ${alias} (si eras el anfitrión).` });
        }

        case 'room_status': {
          const res = await withDaemon(() => callControl({ op: 'status' }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        default:
          return textResult(`tool desconocida: ${name}`, true);
      }
    } catch (error: unknown) {
      if (error instanceof DaemonNotRunningError) return textResult(error.message, true);
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
  });

  await server.connect(new StdioServerTransport());
}
