import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { describeConfig, loadConfig, resolveServerAddress, type LoadedConfig } from "./config";
import { createHttpServer } from "./http/server";
import { FsResourceProvider } from "./resources/fs-provider";
import { RuntimeHub, type LogLevel } from "./ws/hub";

export interface RunningServer {
  readonly server: Server;
  readonly hub: RuntimeHub;
  readonly config: LoadedConfig;
  readonly url: string;
  close(): Promise<void>;
}

function createLogger(): (level: LogLevel, message: string) => void {
  return (level, message) => {
    const stamp = new Date().toISOString().slice(11, 19);
    const stream = level === "error" ? console.error : console.log;
    stream(`${stamp} [${level}] ${message}`);
  };
}

/** 启动后端：资源提供器 + 运行态中枢 + HTTP/WS 服务。 */
export async function startServer(): Promise<RunningServer> {
  const config = await loadConfig();
  const log = createLogger();
  const provider = new FsResourceProvider(config.resourceRoot, config.dirs);
  const hub = new RuntimeHub(log);
  const server = createHttpServer({ config, provider, hub, log });
  hub.attach(server);

  const { host, port } = resolveServerAddress(config.app);

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });

  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${port}`;
  log("info", `DiceTaleStudio 服务端已启动: ${url}`);
  log("info", describeConfig(config));
  log("info", `WebSocket: ${url.replace("http", "ws")}/client（前端）、/editor（编辑器）`);

  return {
    server,
    hub,
    config,
    url,
    close: async () => {
      hub.close();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  startServer().catch((error: unknown) => {
    console.error("启动失败:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
