import type { OutboundResult } from '../../../application/ports/index.js';
import { callControl } from '../control-server.js';
import { fail, usage } from './io.js';

const DEFAULT_TTL_SECONDS = 120;

export async function runAsk(args: string[]): Promise<void> {
  const [to, ...rest] = args;
  const question = rest.filter((arg) => !arg.startsWith('--')).join(' ');
  if (!to || !question) usage();

  const response = await callControl({ op: 'ask', to, question, ttl: DEFAULT_TTL_SECONDS });
  if (!response.ok) fail(response.error);

  const result = response.data as OutboundResult;
  if (!result.ok) fail(`sin respuesta: ${result.error ?? 'desconocido'}`);

  console.log(`\n${result.answer}\n`);

  if (result.sources?.length) {
    console.log('Fuentes:');
    for (const source of result.sources) {
      console.log(`  ${source.file}${source.line ? `:${source.line}` : ''}`);
    }
  }

  const meta = [
    result.from,
    result.sha ? `@${result.sha}` : undefined,
    result.confidence,
    result.cached ? 'cacheado' : `${Math.round((result.elapsedMs ?? 0) / 1000)}s`,
  ].filter(Boolean);
  console.log(`\n— ${meta.join(' · ')}`);
}

export async function runQuery(op: 'status' | 'members'): Promise<void> {
  const response = await callControl({ op });
  console.log(JSON.stringify(response.ok ? response.data : response.error, null, 2));
}
