import * as fs from 'fs';
import * as path from 'path';

function findJsonSchemas(dir: string) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        findJsonSchemas(fullPath);
      } else if (file.endsWith('.json')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('cuerpoDocumento') && content.includes('otrosDocumentos')) {
          console.log(`Potential DTE schema: ${fullPath}`);
        }
      }
    } catch (err) {}
  }
}

const workspaceParent = 'c:\\Users\\jonathan.giron\\.gemini\\antigravity\\scratch';
console.log('Searching in:', workspaceParent);
findJsonSchemas(workspaceParent);
findJsonSchemas('c:\\Users\\jonathan.giron\\.gemini\\antigravity');
