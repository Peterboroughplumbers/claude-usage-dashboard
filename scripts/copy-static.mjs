// Copies static renderer assets (html/css) into dist/ui/renderer.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src', 'renderer');
const dest = join(process.cwd(), 'dist', 'ui', 'renderer');
mkdirSync(dest, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(join(src, f), join(dest, f));
console.log('Static assets copied to', dest);
