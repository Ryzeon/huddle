import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { normalizeAlias } from '@huddle/protocol';
import { callControl, DaemonNotRunningError } from './control-server.js';
import { CONFIG_PATH, DEFAULT_CONFIG, loadConfig, saveConfig, type Config } from '../../config.js';
import { existsSync } from 'node:fs';
import { ensureDaemonRunning } from './daemon-launcher.js';

function pick(...valores: unknown[]): string | undefined {
  for (const valor of valores) {
    if (typeof valor === 'string' && valor.trim()) return valor.trim();
  }
  return undefined;
}

function readConfigOrNull(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return loadConfig();
  } catch {
    // Una configuración a medias no debe impedir entrar a una sala nueva.
    return null;
  }
}

/** El socket tarda un instante en soltarse tras el `shutdown`. */
async function waitForDaemonToStop(): Promise<void> {
  for (let intento = 0; intento < 20; intento++) {
    await new Promise((listo) => setTimeout(listo, 100));
    try {
      await callControl({ op: 'status' });
    } catch {
      return;
    }
  }
}

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
    name: 'room_join',
    description:
      'Entra a una sala de Huddle con el código que te pasaron. El alias y el ' +
      'hub son opcionales: si no se dan, se usan los de la configuración del ' +
      'MCP (HUDDLE_ALIAS y HUDDLE_HUB) y, en su defecto, los de la sala ' +
      'anterior. Entrar a otra sala te saca de la actual.',
    inputSchema: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          description: 'El código completo de la sala, tal cual te lo pasaron.',
        },
        alias: {
          type: 'string',
          description: 'Con qué nombre apareces. Por defecto, HUDDLE_ALIAS.',
        },
        hub: {
          type: 'string',
          description: 'A qué hub conectarse. Por defecto, HUDDLE_HUB.',
        },
      },
      required: ['room'],
    },
  },
  {
    name: 'room_leave',
    description:
      'Sale de la sala: para el daemon y deja de exponer tus repositorios. La ' +
      'sala sigue viva para los demás. Tu configuración se conserva, así que ' +
      'volver es entrar otra vez con el mismo código.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'room_close',
    description:
      'Cierra la sala para todos y borra su historial. Solo funciona si eres ' +
      'el anfitrión; si no, el hub lo rechaza. Es irreversible: el código deja ' +
      'de servir. Para salir tú solo, usa room_leave.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo, que se le muestra a los demás.' },
      },
    },
  },
  {
    name: 'room_pending',
    description:
      'Lista quién está esperando a entrar en una sala con aprobación. Cada ' +
      'solicitud trae un `id`, el alias que pide y la cola de su clave (`key`). ' +
      'ENSÉÑALE SIEMPRE a la persona el alias Y la key juntos, y dile que ' +
      'compruebe esa key con quien dice ser por otro canal (mensaje, voz) antes ' +
      'de decidir. El alias lo elige quien entra; la key es lo único que no se ' +
      'puede falsificar.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'room_admit',
    description:
      'Deja entrar a quien espera, por el `id` de su solicitud (nunca por alias: ' +
      'dos personas pueden pedir el mismo). NO lo llames por tu cuenta: pregunta ' +
      'primero, enseñando alias y key, y espera una confirmación explícita. Por ' +
      'defecto se recuerda y la próxima vez entra directo.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'El `id` que devolvió room_pending.' },
        remember: {
          type: 'boolean',
          description: 'false = solo por esta vez; la próxima vuelve a pedir permiso.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'room_deny',
    description:
      'Rechaza a quien espera, por el `id` de su solicitud. Se le cierra la ' +
      'conexión. Ante la duda sobre quién es de verdad, rechazar es lo correcto: ' +
      'siempre puede volver a pedirlo.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'El `id` que devolvió room_pending.' },
        reason: { type: 'string', description: 'Motivo, que se le muestra.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'room_rotate',
    description:
      'Cambia el código de la sala. Solo el anfitrión. La sala, su historial y ' +
      'su dueño siguen igual, pero a todos los demás se les cierra la conexión ' +
      'y necesitan el código nuevo para volver. Es la respuesta a un código ' +
      'filtrado. Enséñale el código nuevo a quien te lo pidió: nadie más lo recibe.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Motivo, que se le muestra a los demás.' },
      },
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
    name: 'room_folder',
    description:
      'Lista la carpeta compartida de la sala: el cuaderno común del equipo. ' +
      'Devuelve también `dir`, la ruta donde está sincronizada en este disco — ' +
      'si la tienes, LEE Y BUSCA AHÍ DIRECTAMENTE con Read y Grep en vez de ' +
      'llamar a room_folder_read, que es más rápido y no gasta un viaje. Los ' +
      'archivos se enlazan con wikilinks: buscar "[[temas/algo]]" saca todo lo ' +
      'que se ha hablado de ese tema en la sala.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'room_folder_read',
    description:
      'Lee un archivo de la carpeta de la sala. Úsalo solo si no puedes leer el ' +
      'directorio que devuelve room_folder (por ejemplo, porque está fuera de ' +
      'tu directorio de trabajo).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta dentro de la carpeta, ej. "notas/api.md".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_folder_write',
    description:
      'Escribe una nota en la carpeta de la sala, que verán —y leerán sus ' +
      'agentes— todos los miembros. Úsalo cuando el usuario quiera dejar algo ' +
      'apuntado para el equipo: una decisión, una convención, contexto que hoy ' +
      'solo está en su cabeza. Reemplaza el archivo si ya existía, así que lee ' +
      'antes si vas a añadir a algo. Escribe siempre bajo "notas/": el resto de ' +
      'la carpeta la genera el hub y se regenera sola. Enlaza a otras notas con ' +
      'wikilinks, [[notas/otra]], para que se encuentren entre ellas.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Ruta dentro de la carpeta, ej. "notas/despliegue.md".',
        },
        text: { type: 'string', description: 'El contenido completo del archivo, en Markdown.' },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'room_folder_remove',
    description:
      'Borra un archivo de la carpeta de la sala. Se lo borra a todo el mundo, ' +
      'no solo a ti, así que confírmalo con el usuario antes.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta dentro de la carpeta.' },
      },
      required: ['path'],
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

        case 'room_join': {
          const entrada = (args ?? {}) as { room?: unknown; alias?: unknown; hub?: unknown };
          const room = typeof entrada.room === 'string' ? entrada.room.trim() : '';
          if (!room) return textResult('falta el código de la sala', true);

          // Precedencia: lo que pide quien llama, luego el entorno del MCP
          // (`claude mcp add --env HUDDLE_ALIAS=…`), y por último la sala en
          // la que ya estabas. Sin ninguno de los tres, no hay nada que hacer.
          const previa = readConfigOrNull();
          const alias = pick(entrada.alias, process.env['HUDDLE_ALIAS'], previa?.alias);
          const hub = pick(entrada.hub, process.env['HUDDLE_HUB'], previa?.hub);
          if (!alias) return textResult('no sé con qué alias entrar. Ponlo, o define HUDDLE_ALIAS', true);
          if (!hub) return textResult('no sé a qué hub. Ponlo, o define HUDDLE_HUB', true);

          const salidaDe = previa?.room;
          saveConfig({
            ...DEFAULT_CONFIG,
            ...(previa ?? {}),
            room,
            alias: normalizeAlias(alias),
            hub,
            workspaces: previa?.workspaces ?? [{ cwd: process.cwd() }],
          });

          // El daemon vivo sigue con la sala vieja en memoria, así que se
          // apaga y se levanta de nuevo leyendo lo recién escrito.
          try {
            await callControl({ op: 'shutdown' });
            await waitForDaemonToStop();
          } catch {
            // No estaba corriendo: mejor todavía.
          }
          await ensureDaemonRunning();

          return textResult({
            room,
            alias: normalizeAlias(alias),
            hub,
            ...(salidaDe && salidaDe !== room ? { saliste_de: salidaDe } : {}),
          });
        }

        case 'room_leave': {
          try {
            await callControl({ op: 'shutdown' });
          } catch {
            return textResult('no estabas en ninguna sala');
          }
          return textResult({ salido: true });
        }

        case 'room_close': {
          const motivo = (args ?? {})['reason'];
          const res = await withDaemon(() =>
            callControl(
              typeof motivo === 'string' && motivo
                ? { op: 'close', reason: motivo }
                : { op: 'close' },
            ),
          );
          if (!res.ok) return textResult(res.error, true);
          return textResult({ cerrada: true });
        }

        case 'room_pending': {
          const res = await withDaemon(() => callControl({ op: 'pending' }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_admit': {
          const a = (args ?? {}) as { id?: unknown; remember?: unknown };
          if (typeof a.id !== 'string') {
            return textResult('room_admit necesita `id` como string.', true);
          }
          const id = a.id;
          const remember = a.remember === false ? false : undefined;
          const res = await withDaemon(() => callControl({ op: 'admit', id, remember }));
          if (!res.ok) return textResult(res.error, true);
          return textResult({ ok: true, mensaje: `Admitido ${id} (si eras el anfitrión).` });
        }

        case 'room_deny': {
          const a = (args ?? {}) as { id?: unknown; reason?: unknown };
          if (typeof a.id !== 'string') {
            return textResult('room_deny necesita `id` como string.', true);
          }
          const id = a.id;
          const reason = typeof a.reason === 'string' ? a.reason : undefined;
          const res = await withDaemon(() => callControl({ op: 'deny', id, reason }));
          if (!res.ok) return textResult(res.error, true);
          return textResult({ ok: true, mensaje: `Rechazado ${id}.` });
        }

        case 'room_rotate': {
          const motivo = (args ?? {})['reason'];
          const res = await withDaemon(() =>
            callControl(
              typeof motivo === 'string' && motivo
                ? { op: 'rotate', reason: motivo }
                : { op: 'rotate' },
            ),
          );
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

        case 'room_folder': {
          const res = await withDaemon(() => callControl({ op: 'folder_list' }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_folder_read': {
          const a = (args ?? {}) as { path?: unknown };
          if (typeof a.path !== 'string') {
            return textResult('room_folder_read necesita `path` como string.', true);
          }
          const path = a.path;
          const res = await withDaemon(() => callControl({ op: 'folder_read', path }));
          if (!res.ok) return textResult(res.error, true);
          return textResult((res.data as { text?: string }).text ?? '');
        }

        case 'room_folder_write': {
          const a = (args ?? {}) as { path?: unknown; text?: unknown };
          if (typeof a.path !== 'string' || typeof a.text !== 'string') {
            return textResult('room_folder_write necesita `path` y `text` como strings.', true);
          }
          const path = a.path;
          const text = a.text;
          const res = await withDaemon(() => callControl({ op: 'folder_write', path, text }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
        }

        case 'room_folder_remove': {
          const a = (args ?? {}) as { path?: unknown };
          if (typeof a.path !== 'string') {
            return textResult('room_folder_remove necesita `path` como string.', true);
          }
          const path = a.path;
          const res = await withDaemon(() => callControl({ op: 'folder_remove', path }));
          if (!res.ok) return textResult(res.error, true);
          return textResult(res.data);
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
