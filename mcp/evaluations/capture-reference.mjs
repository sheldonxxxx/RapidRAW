import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const client = new Client({name:'rapidraw-read-only-reference',version:'1.0.0'});
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'--binary',process.env.RAPIDRAW_BINARY,'--workspace',process.env.RAPIDRAW_WORKSPACE],stderr:'inherit'}));
  const capabilities=await client.callTool({name:'rapidraw_capabilities',arguments:{}});
  if(capabilities.isError)throw new Error(JSON.stringify(capabilities));
  capabilities.structuredContent.workspace = '/fixture/rapidraw';
  const settings=await client.callTool({name:'rapidraw_get_engine_settings',arguments:{}});
  const tools=await client.listTools();
  const workflow=await client.readResource({uri:'rapidraw://workflow'});
  await writeFile(fileURLToPath(new URL('./reference.json',import.meta.url)),JSON.stringify({fixture_version:2,capabilities:capabilities.structuredContent,settings:settings.structuredContent,tools:tools.tools,workflow:workflow.contents[0].text},null,2));
  console.log('Captured live read-only engine reference.');
} finally {await client.close();}
