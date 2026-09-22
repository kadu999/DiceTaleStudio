/**
 * 一次性探针：以编辑器的身份连 `/editor`，看服务端是接受还是以什么 close code/reason 踢掉。
 *
 * 用 Node 自带的 WebSocket（不需要 `ws` 依赖）。
 * 用法：node probe-editor-ws.mjs [protocolVersion]
 */
const version = Number(process.argv[2] ?? 4);
const url = process.env.PROBE_URL ?? "ws://127.0.0.1:1420/editor";
const socket = new WebSocket(url);
let opened = false;

socket.addEventListener("open", () => {
  opened = true;
  console.log(`[open] ${url}，发送 editor_hello protocolVersion=${version}`);
  socket.send(JSON.stringify({ type: "editor_hello", protocolVersion: version }));
});

socket.addEventListener("message", (event) => {
  console.log(`[message] ${String(event.data).slice(0, 200)}`);
});

socket.addEventListener("close", (event) => {
  console.log(`[close] code=${event.code} reason=${event.reason || "(空)"}`);
  process.exit(0);
});

socket.addEventListener("error", () => {
  console.log("[error] 连接出错（细节由 close 给出）");
});

setTimeout(() => {
  console.log(opened && socket.readyState === WebSocket.OPEN ? "[幸存] 3 秒后连接仍然开着" : "[未连上/已断]");
  socket.close();
  process.exit(0);
}, 3000);
