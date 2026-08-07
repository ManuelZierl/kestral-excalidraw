import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Whiteboard root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
