import * as fs from 'fs';

function main() {
  const logPath = 'c:/Users/jonathan.giron/.gemini/antigravity/brain/1c9b9e30-43c5-4e3f-8fab-d02f7e8732e0/.system_generated/logs/overview.txt';
  const fileContent = fs.readFileSync(logPath, 'utf8');
  
  // Find "ok ahora revisemos la implementacion de documento contable 09"
  const targetStr = 'ok ahora revisemos la implementacion de documento contable 09 aca el json';
  const idx = fileContent.indexOf(targetStr);
  if (idx === -1) {
    console.log('Target string not found.');
    return;
  }
  
  console.log('Found target at index:', idx);
  // Write the next 15000 characters to a file src/untruncated_schema.txt
  const slice = fileContent.substring(idx, idx + 15000);
  fs.writeFileSync('src/untruncated_schema.txt', slice, 'utf8');
  console.log('Written to src/untruncated_schema.txt');
}

main();
