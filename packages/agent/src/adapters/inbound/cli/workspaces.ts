import { resolve } from 'node:path';
import {
  assertUniqueTags,
  assignTag,
  loadConfig,
  saveConfig,
  type Workspace,
} from '../../../config.js';

// Las mismas reglas valen con daemon y sin él, así que viven en un solo sitio:
// escritas dos veces acabarían divergiendo y el archivo diría una cosa y el
// proceso vivo otra.

export function addWorkspaceToConfig(path: string, tag?: string): Workspace {
  const config = loadConfig();
  const cwd = resolve(path);

  if (config.workspaces.some((workspace) => workspace.cwd === cwd)) {
    throw new Error(`ese repositorio ya está expuesto: ${cwd}`);
  }

  const taken = config.workspaces
    .map((workspace) => workspace.tag)
    .filter((value): value is string => Boolean(value));

  const added: Workspace = { cwd, tag: tag ?? assignTag(cwd, taken) };
  const workspaces = [...config.workspaces, added];
  assertUniqueTags(workspaces);

  saveConfig({ ...config, workspaces });
  return added;
}

export function removeWorkspaceFromConfig(tag: string): { removed: string; remaining: number } {
  const config = loadConfig();
  const workspaces = config.workspaces.filter((workspace) => workspace.tag !== tag);

  if (workspaces.length === config.workspaces.length) {
    throw new Error(`no hay ningún repositorio con el tag "${tag}"`);
  }
  if (workspaces.length === 0) {
    throw new Error('no puedes quitar el último repositorio');
  }

  saveConfig({ ...config, workspaces });
  return { removed: tag, remaining: workspaces.length };
}
