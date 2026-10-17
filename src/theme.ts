export type Theme = 'system' | 'light' | 'dark';
const key = 'private-board-theme';
let theme: Theme = 'system';
try { const saved = localStorage.getItem(key); if (saved === 'light' || saved === 'dark') theme = saved; } catch { /* storage may be disabled */ }
const media = matchMedia('(prefers-color-scheme: dark)');
function apply() {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151917' : '#f7f7f4');
}
media.addEventListener('change', apply);
apply();
export function getTheme(): Theme { return theme; }
export function cycleTheme(): Theme {
  theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  try { localStorage.setItem(key, theme); } catch { /* preference is optional */ }
  apply(); return theme;
}
