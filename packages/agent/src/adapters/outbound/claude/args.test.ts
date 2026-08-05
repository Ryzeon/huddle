import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, buildGuardrails, buildSettings } from './args.js';
import { describeToolUse, parseAnswerPayload } from './stream.js';

const BASE = {
  question: '¿dónde está el login?',
  cwd: '/repo',
  model: 'sonnet',
  effort: 'low',
  tools: ['Read', 'Grep', 'Glob'],
  denyPaths: ['.env', 'secrets/**'],
  timeoutMs: 90_000,
  askedBy: '@ryzeon',
};

/**
 * Estos tests son un candado de seguridad, no de estilo: si alguien quita
 * `--strict-mcp-config` o mete una herramienta de escritura, se rompe aquí y
 * no en producción con el repo de un compañero delante.
 */
describe('buildArgs', () => {
  test('aísla los MCP servers del dueño', () => {
    const args = buildArgs(BASE);
    assert.ok(args.includes('--strict-mcp-config'));
    const idx = args.indexOf('--mcp-config');
    assert.equal(args[idx + 1], '{"mcpServers":{}}');
  });

  test('solo pasa herramientas de lectura', () => {
    const args = buildArgs(BASE);
    const tools = args[args.indexOf('--tools') + 1]!;
    for (const forbidden of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      assert.ok(!tools.includes(forbidden), `${forbidden} no debería estar permitido`);
    }
    assert.equal(tools, 'Read,Grep,Glob');
  });

  test('incluye --verbose, que el CLI exige junto a stream-json', () => {
    const args = buildArgs(BASE);
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  });

  test('forkea la sesión en vez de escribir en la del dueño', () => {
    const args = buildArgs({ ...BASE, resumeSessionId: 'sess-1' });
    assert.ok(args.includes('--fork-session'));
    assert.equal(args[args.indexOf('--resume') + 1], 'sess-1');
  });

  test('sin sesión previa no manda --resume ni --fork-session', () => {
    const args = buildArgs(BASE);
    assert.ok(!args.includes('--resume'));
    assert.ok(!args.includes('--fork-session'));
  });

  test('el esquema de salida pide fuentes y confianza', () => {
    const args = buildArgs(BASE);
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!) as {
      required: string[];
    };
    assert.deepEqual(schema.required.sort(), ['answer', 'confidence', 'sources']);
  });
});

describe('buildSettings', () => {
  test('deniega cada ruta prohibida en raíz y anidada', () => {
    const settings = JSON.parse(buildSettings(['.env'])) as {
      permissions: { deny: string[] };
    };
    const deny = settings.permissions.deny;
    assert.ok(deny.includes('Read(.env)'));
    assert.ok(deny.includes('Read(./.env)'));
    assert.ok(
      deny.includes('Read(**/.env)'),
      'un .env anidado debe quedar cubierto igual que el de la raíz',
    );
  });

  test('cierra también Grep, que si no filtraría el contenido igual', () => {
    const settings = JSON.parse(buildSettings(['secrets/**'])) as {
      permissions: { deny: string[] };
    };
    assert.ok(settings.permissions.deny.some((rule) => rule.startsWith('Grep(')));
  });

  test('las reglas viajan en los args, no solo en el prompt', () => {
    const args = buildArgs(BASE);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as {
      permissions: { deny: string[] };
    };
    assert.ok(settings.permissions.deny.length > 0);
  });
});

describe('buildGuardrails', () => {
  test('nombra las rutas prohibidas y a quien pregunta', () => {
    const prompt = buildGuardrails(BASE);
    assert.ok(prompt.includes('.env'));
    assert.ok(prompt.includes('secrets/**'));
    assert.ok(prompt.includes('@ryzeon'));
    assert.ok(prompt.toLowerCase().includes('solo lectura'));
  });
});

describe('parseAnswerPayload', () => {
  test('parsea la forma esperada', () => {
    const out = parseAnswerPayload(
      '{"answer":"en src/auth.ts","sources":[{"file":"src/auth.ts","line":4}],"confidence":"high"}',
    );
    assert.equal(out.answer, 'en src/auth.ts');
    assert.deepEqual(out.sources, [{ file: 'src/auth.ts', line: 4 }]);
    assert.equal(out.confidence, 'high');
  });

  test('degrada a texto plano en vez de perder la respuesta', () => {
    const out = parseAnswerPayload('esto no es json');
    assert.equal(out.answer, 'esto no es json');
    assert.equal(out.confidence, 'low');
    assert.equal(out.needsEscalation, true);
  });

  test('descarta fuentes malformadas sin tirar la respuesta', () => {
    const out = parseAnswerPayload(
      '{"answer":"ok","sources":[{"file":"a.ts"},{"nope":1},"basura"],"confidence":"medium"}',
    );
    assert.deepEqual(out.sources, [{ file: 'a.ts' }]);
    assert.equal(out.answer, 'ok');
  });

  test('un JSON roto no revienta', () => {
    const out = parseAnswerPayload('{"answer":"a medio');
    assert.equal(out.confidence, 'low');
  });
});

describe('describeToolUse', () => {
  test('traduce a lenguaje humano', () => {
    assert.equal(describeToolUse('Read', { file_path: 'src/a.ts' }), 'leyendo src/a.ts');
    assert.equal(describeToolUse('Grep', { pattern: 'authFn' }), 'buscando "authFn"');
    assert.equal(describeToolUse('Otra', {}), 'usando Otra');
  });

  test('acorta rutas larguísimas', () => {
    const long = `src/${'x'.repeat(200)}.ts`;
    const out = describeToolUse('Read', { file_path: long });
    assert.ok(out.length < 100);
    assert.ok(out.includes('…'));
  });
});

describe('la carpeta de la sala en el motor', () => {
  const CON_CARPETA = { ...BASE, folderDir: '/home/yo/.huddle/carpeta' };

  test('entra como directorio adicional, no como texto en el prompt', () => {
    const args = buildArgs(CON_CARPETA);
    assert.equal(args[args.indexOf('--add-dir') + 1], '/home/yo/.huddle/carpeta');
  });

  test('sin carpeta no se pasa --add-dir', () => {
    assert.ok(!buildArgs(BASE).includes('--add-dir'));
  });

  test('sigue sin poder escribir en ella: las tools no cambian', () => {
    const args = buildArgs(CON_CARPETA);
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  });

  test('el prompt dice dónde está y que el código manda sobre la carpeta', () => {
    const prompt = buildGuardrails(CON_CARPETA);
    assert.match(prompt, /\/home\/yo\/\.huddle\/carpeta/);
    assert.match(prompt, /manda el código/);
  });

  test('sin carpeta, el prompt no habla de ninguna', () => {
    assert.equal(buildGuardrails(BASE).includes('carpeta'), false);
  });

  test('las reglas de siempre no se pierden al añadir la carpeta', () => {
    const prompt = buildGuardrails(CON_CARPETA);
    assert.match(prompt, /Solo lectura/);
    assert.match(prompt, /\.env/);
    assert.match(prompt, /Una respuesta sin fuentes no sirve/);
  });
});
