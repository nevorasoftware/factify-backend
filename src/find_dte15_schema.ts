import * as fs from 'fs';
import * as path from 'path';

const targetDirs = [
  'C:\\Users\\jonathan.giron\\.gemini\\antigravity\\brain\\4ea64500-97f1-4eae-bb15-bf67e66479e1\\.system_generated\\logs\\overview.txt',
  'C:\\Users\\jonathan.giron\\.gemini\\antigravity\\brain\\a6bdf53f-c775-407c-ad90-54e019897a9d\\.system_generated\\logs\\overview.txt'
];

for (const filePath of targetDirs) {
  if (fs.existsSync(filePath)) {
    console.log('Scanning:', filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Find all occurrences of "otrosDocumentos"
    let index = content.indexOf('otrosDocumentos');
    while (index !== -1) {
      console.log('--- FOUND "otrosDocumentos" at index', index, '---');
      const start = Math.max(0, index - 500);
      const end = Math.min(content.length, index + 2000);
      console.log(content.substring(start, end));
      
      index = content.indexOf('otrosDocumentos', index + 1);
    }
  }
}
