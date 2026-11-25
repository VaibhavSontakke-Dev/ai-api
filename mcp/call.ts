/** Drive the MCP server over stdio from a shell, one session, without a model: npm run mcp -- [--user name] tool '{"json":"args"}' [tool args]... */
import { connect } from './demo.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--user');
const user = at >= 0 ? args.splice(at, 2)[1]! : 'sam.support';
const client = await connect(user);
if (args.length === 0) {
  for (const t of (await client.listTools()).tools) console.log(`${t.name}\n  ${t.description}\n  ${JSON.stringify(t.inputSchema)}`);
}
for (let i = 0; i < args.length; i += 2) {
  const r = await client.callTool({ name: args[i]!, arguments: JSON.parse(args[i + 1] ?? '{}') as Record<string, unknown> });
  console.log(`> ${args[i]} ${args[i + 1] ?? '{}'}\n${r.isError ? '[error] ' : ''}${(r.content as { text: string }[])[0]!.text}\n`);
}
await client.close();
