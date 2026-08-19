// Copies static assets (renderer html/css, terminal wrapper script) into dist/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), 'src', 'renderer');
const dest = join(process.cwd(), 'dist', 'ui', 'renderer');
mkdirSync(dest, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(join(src, f), join(dest, f));
// The Claude Code auto-switch wrapper is shipped next to the compiled main process and
// installed into userData/helpers at runtime.
const scriptsDest = join(process.cwd(), 'dist', 'main', 'scripts');
mkdirSync(scriptsDest, { recursive: true });
copyFileSync(join(process.cwd(), 'src', 'main', 'scripts', 'claude-auto.ps1'), join(scriptsDest, 'claude-auto.ps1'));
copyFileSync(join(process.cwd(), 'src', 'main', 'scripts', 'claude-shim.ps1'), join(scriptsDest, 'claude-shim.ps1'));
console.log('Static assets copied to', dest);
