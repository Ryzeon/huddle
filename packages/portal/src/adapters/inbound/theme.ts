/**
 * Tema claro y oscuro.
 *
 * Por defecto el oscuro, aunque el sistema pida claro. La elección manual gana
 * sobre ambos y se recuerda.
 */

export type Theme = 'oscuro' | 'claro';

const KEY = 'huddle.portal.tema';

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'claro' || saved === 'oscuro') return saved;
  } catch {
    // sin almacenamiento: se cae al principal
  }
  return 'oscuro';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['tema'] = theme;
  document.documentElement.style.colorScheme = theme === 'oscuro' ? 'dark' : 'light';
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // idem
  }
}

export function toggleTheme(current: Theme): Theme {
  return current === 'oscuro' ? 'claro' : 'oscuro';
}
