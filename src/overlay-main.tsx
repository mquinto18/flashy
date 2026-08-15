// Entry point for the floating auto-close warning window.
//
// Deliberately does NOT mount <App/>: this is a separate webview with its own JS heap,
// so pulling in the main app would boot a second copy of every store and its
// persistence subscription. The overlay is self-contained and event-driven.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { CloseOverlay } from "./components/CloseOverlay";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CloseOverlay />
  </StrictMode>,
);
