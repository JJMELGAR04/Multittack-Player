import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/index.css";
import { backend, isNativeAvailable } from "./lib/ipc/client";

// Unexpected interface errors are written to the app's error log.
if (isNativeAvailable()) {
  const report = (msg: string) => void backend.logUiError(msg.slice(0, 2000)).catch(() => {});
  window.addEventListener("error", (e) => report(`${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener("unhandledrejection", (e) => report(`promesa sin manejar: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
