import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";

async function bootstrap(): Promise<void> {
  if (new URLSearchParams(window.location.search).get("debug") === "1") {
    try {
      const { default: eruda } = await import("eruda");
      eruda.init({
        defaults: { displaySize: 50, transparency: 0.95 },
        useShadowDom: true,
      });
    } catch (error) {
      console.error("移动端调试面板加载失败", error);
    }
  }

  const container = document.getElementById("root");
  if (container === null) {
    throw new Error("找不到 #root 挂载点");
  }

  const { App } = await import("./App");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
