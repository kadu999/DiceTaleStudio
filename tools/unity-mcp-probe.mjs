/**
 * Self-contained probe: imports the MCP SDK from the DSH profile install by
 * absolute path, so it runs from any working directory.
 *
 * Usage: node tools/unity-mcp-probe.mjs [url]
 */
const SDK_ROOT = 'file:///C:/Users/90683/.dsh/profiles/node_modules/@modelcontextprotocol/sdk/dist/esm/'

const { Client } = await import(`${SDK_ROOT}client/index.js`)
const { StreamableHTTPClientTransport } = await import(`${SDK_ROOT}client/streamableHttp.js`)

const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8080/mcp')
const client = new Client({ name: 'dsh-unity-probe', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(url)

/** DSH public name contract: mcp__<serverName>__<rawName>. */
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 51)}_lossy`
}

try {
  await client.connect(transport)
  console.log(`connected: ${transport.sessionId ?? '(no session id)'}`)

  const info = client.getServerVersion()
  console.log(`server: ${info?.name} ${info?.version}`)
  console.log(`instructions: ${client.getInstructions() ? 'present' : 'absent'}`)

  const { tools } = await client.listTools()
  console.log(`\ndiscovered ${tools.length} tools; DSH will expose them as:`)
  for (const tool of tools) {
    console.log(`  ${publicToolName('unity', tool.name)}`)
  }
} catch (error) {
  console.error(`FAILED: ${error?.message ?? error}`)
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
}
