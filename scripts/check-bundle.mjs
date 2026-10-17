import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const files = await readdir('dist/assets');
let javascript = 0, css = 0, shell=0;
for (const name of files) {
  const bytes = await readFile(`dist/assets/${name}`);
  const content = bytes.toString();
  if (/SUPABASE_SECRET_KEY|RATE_LIMIT_SECRET|scrypt\$|sb_secret_|create_board_with_session|consume_rate_limit|limitInputPixels|libvips/.test(content)) throw new Error(`Server-only reference leaked into ${name}`);
  for (const key of ['SUPABASE_SECRET_KEY', 'RATE_LIMIT_SECRET']) {
    if (process.env[key] && content.includes(process.env[key])) throw new Error(`Secret value leaked into ${name}`);
  }
  if (name.endsWith('.js')) {javascript += gzipSync(bytes).length;if(name.startsWith('index-'))shell+=gzipSync(bytes).length;}
  if (name.endsWith('.css')) css += gzipSync(bytes).length;
}
console.log(`Compressed browser assets: shell ${(shell/1024).toFixed(1)} KiB; all JS ${(javascript / 1024).toFixed(1)} KiB; CSS ${(css / 1024).toFixed(1)} KiB`);
if (shell>40*1024 || javascript > 100 * 1024 || css > 15 * 1024) throw new Error('Browser asset budget exceeded');
