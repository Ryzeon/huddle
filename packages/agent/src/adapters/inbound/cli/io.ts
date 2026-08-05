export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function usage(): never {
  console.error(
    [
      'huddle — salas donde el agente de IA de cada quien responde a sus compañeros',
      '',
      'Comandos:',
      '  create "<nombre>" <@alias>  Crear una sala; imprime su código',
      '    --hub <url>          ws://host:8787 (por defecto localhost)',
      '    --cwd <dir>          Repo a exponer (por defecto, el actual)',
      '    --quota <n>          Preguntas entrantes por día',
      '',
      '  join <codigo> <@alias> Entrar con el código que te pasaron',
      '    --hub <url>          ws://host:8787 (por defecto localhost)',
      '    --cwd <dir>          Repo a exponer (por defecto, el actual)',
      '    --tag <nombre>       Etiqueta del repo (por defecto, el nombre de la carpeta)',
      '    --quota <n>          Preguntas entrantes por día (`none` = sin tope)',
      '    --force              Reemplazar una configuración existente',
      '',
      '  rejoin <codigo>        Volver a entrar con otro código, sin tocar nada más',
      '',
      '  add-repo <dir>         Exponer otro repo, con la MISMA cuota',
      '    --tag <nombre>       Opcional: por defecto usa el nombre de la carpeta',
      '  remove-repo <tag>      Dejar de exponer un repo',
      '  repos                  Listar los repos configurados',
      '',
      '  daemon                 Mantener la presencia y atender preguntas',
      '  stop                   Parar el daemon y salir de la sala',
      '  mcp                    Servidor MCP por stdio (lo lanza tu agente)',
      '  ask <destino> "..."    Preguntar desde la terminal',
      '  kick <@alias>          Expulsar a alguien (solo el anfitrión)',
      '  rotate                 Cambiar el código de la sala (solo el anfitrión)',
      '  close                  Cerrar la sala del todo (solo el anfitrión)',
      '  who                    Quién está en la sala',
      '  status                 Estado de tu agente',
    ].join('\n'),
  );
  process.exit(1);
}
