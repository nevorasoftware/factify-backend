import * as fs from 'fs';

function main() {
  const logPath = 'c:/Users/jonathan.giron/.gemini/antigravity/brain/1c9b9e30-43c5-4e3f-8fab-d02f7e8732e0/.system_generated/logs/overview.txt';
  const fileContent = fs.readFileSync(logPath, 'utf8');
  
  let output = '';
  let idx = 0;
  while (true) {
    idx = fileContent.indexOf('$schema', idx);
    if (idx === -1) break;
    
    const start = Math.max(0, idx - 500);
    const end = Math.min(fileContent.length, idx + 1500);
    output += `--- Match at index ${idx} ---\n`;
    output += fileContent.substring(start, end) + '\n';
    output += '-----------------------------\n\n';
    idx += '$schema'.length;
  }
  
  fs.writeFileSync('src/schema_schema_results.txt', output, 'utf8');
  console.log('Results written to src/schema_schema_results.txt successfully.');
}

main();
