import * as fs from 'fs';
import * as path from 'path';

function main() {
  const logPath = 'c:/Users/jonathan.giron/.gemini/antigravity/brain/1c9b9e30-43c5-4e3f-8fab-d02f7e8732e0/.system_generated/logs/overview.txt';
  const fileContent = fs.readFileSync(logPath, 'utf8');
  const lines = fileContent.split('\n');
  
  // Line 273 is 1-indexed, so 272 in 0-indexed array
  const targetLine = lines[272];
  if (!targetLine) {
    console.log('Line 273 not found.');
    return;
  }
  
  const parsedLine = JSON.parse(targetLine);
  const content = parsedLine.content;
  
  // Extract JSON block starting with {
  const jsonStart = content.indexOf('{');
  if (jsonStart === -1) {
    console.log('No JSON found in line content.');
    return;
  }
  
  const jsonStr = content.substring(jsonStart);
  const schema = JSON.parse(jsonStr);
  
  // Find porcentComision inside the schema
  console.log('DTE 09 Schema title:', schema.title);
  
  const cuerpoDocumentoProps = schema.properties?.cuerpoDocumento?.properties;
  if (cuerpoDocumentoProps) {
    console.log('cuerpoDocumento.porcentComision properties:');
    console.log(JSON.stringify(cuerpoDocumentoProps.porcentComision, null, 2));
  } else {
    console.log('cuerpoDocumento properties not found in schema.');
  }
}

main();
