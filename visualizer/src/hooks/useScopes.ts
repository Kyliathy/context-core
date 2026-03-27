import { useCallback, useEffect, useState } from "react";
import { fetchScopes, saveScopes } from "../api/search";
import type { Scope } from "../types";

export function useScopes(): { scopes: Scope[]; setScopes: (nextScopes: Scope[]) => void; isLoaded: boolean }
{
	const [scopes, setScopesState] = useState<Scope[]>([]);
	const [isLoaded, setIsLoaded] = useState(false);

	useEffect(() =>
	{
		fetchScopes()
			.then((loaded) =>
			{
				setScopesState(loaded);
				setIsLoaded(true);
			})
			.catch(() =>
			{
				setScopesState([]);
				setIsLoaded(true);
			});
	}, []);

	const setScopes = useCallback((nextScopes: Scope[]) =>
	{
		setScopesState(nextScopes);
		saveScopes(nextScopes).catch((err) => console.error("Failed to save scopes", err));
	}, []);

	return { scopes, setScopes, isLoaded };
}
