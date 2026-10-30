import React from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "katex/dist/katex.min.css";
// Vite/HMR or a repeated entry evaluation must never create a second React root
// for the same page. Separate roots can race their workspace/worker snapshots and
// leave duplicate conversation chrome behind.
type PiLabWindow = Window & { __piLabReactRoot?: Root };
const appWindow = window as PiLabWindow;
const container = document.getElementById("root");
if (!container) throw new Error("Pi Lab root element is missing.");
const root = appWindow.__piLabReactRoot ?? createRoot(container);
appWindow.__piLabReactRoot = root;
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
