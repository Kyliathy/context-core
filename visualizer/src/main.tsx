/**
 * main.tsx — Application entry point.
 *
 * Mounts the React root inside <div id="root"> with StrictMode enabled.
 * No routing is configured; the entire app is a single SPA view rendered by App.tsx.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
