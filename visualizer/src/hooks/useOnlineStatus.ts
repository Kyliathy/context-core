import { useEffect, useState } from "react";

/** Tracks navigator.onLine and returns live online/offline status. */
export function useOnlineStatus(): { isOnline: boolean }
{
	const [isOnline, setIsOnline] = useState(navigator.onLine);

	useEffect(() =>
	{
		const handleOnline = () => setIsOnline(true);
		const handleOffline = () => setIsOnline(false);
		window.addEventListener("online", handleOnline);
		window.addEventListener("offline", handleOffline);
		return () =>
		{
			window.removeEventListener("online", handleOnline);
			window.removeEventListener("offline", handleOffline);
		};
	}, []);

	return { isOnline };
}
