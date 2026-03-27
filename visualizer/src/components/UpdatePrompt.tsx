import { useState } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import "./UpdatePrompt.css";

/**
 * UpdatePrompt — SW update toast shown when a new app version is available.
 * Uses vite-plugin-pwa's virtual:pwa-register/react to detect SW updates.
 * registerType: "prompt" means the SW waits for explicit user confirmation.
 */
export default function UpdatePrompt()
{
	const [dismissed, setDismissed] = useState(false);
	const {
		needRefresh: [needRefresh],
		updateServiceWorker,
	} = useRegisterSW();

	if (!needRefresh || dismissed) return null;

	return (
		<div className="update-prompt" role="status" aria-live="polite">
			<span className="update-prompt-text">A new version is available</span>
			<button
				type="button"
				className="update-prompt-reload"
				onClick={() => updateServiceWorker(true)}
			>
				Reload
			</button>
			<button
				type="button"
				className="update-prompt-dismiss"
				aria-label="Dismiss update"
				onClick={() => setDismissed(true)}
			>
				×
			</button>
		</div>
	);
}
