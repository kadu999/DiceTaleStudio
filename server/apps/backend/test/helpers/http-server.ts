import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpServer } from "../../src/http/server";
import { FsResourceProvider } from "../../src/resources/fs-provider";
import { RuntimeHub } from "../../src/ws/hub";
import { createTempResourceRoot } from "./temp-root";

/**
 * 起一个跑在**临时资源根**上的后端（静态托管 + API），返回 `baseUrl` 与收尾函数。
 *
 * 用法：`const server = await startTestServer(); try { … } finally { await server.close(); }`
 */
export async function startTestServer(
  options: { readonly openFolder?: (path: string) => Promise<void> } = {},
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const temp = await createTempResourceRoot();
  const provider = new FsResourceProvider(temp.config.resourceRoot, temp.config.dirs);
  const hub = new RuntimeHub(() => {});

  const server: Server = createHttpServer({
    config: temp.config,
    provider,
    hub,
    log: () => {},
    ...options,
  });
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await temp.dispose();
    },
  };
}
