import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type VSCodeWorkspaceMetaStatus = "ok" | "missing" | "malformed";

type VSCodeWorkspaceMeta = {
	workspace?: string;
	folder?: string;
};

export type VSCodeWorkspaceMetadata = {
	workspaceMetaStatus: VSCodeWorkspaceMetaStatus;
	workspaceUri: string | null;
	workspacePath: string | null;
};

/**
 * Decodes a VS Code `file://` URI into a local filesystem-like path.
 * Matches harness behavior exactly, including Windows `/C:/...` prefix trimming.
 */
export function decodeVSCodeFileUri(uri: string): string
{
	if (!uri.toLowerCase().startsWith("file://"))
	{
		return uri;
	}

	const decoded = decodeURIComponent(uri.replace(/^file:\/\//i, ""));
	if (/^\/[a-zA-Z]:/.test(decoded))
	{
		return decoded.slice(1);
	}
	return decoded;
}

/**
 * Resolves VS Code workspace metadata from `<workspaceStorageHashDir>/workspace.json`.
 */
export function resolveVSCodeWorkspaceMetadata(storagePath: string): VSCodeWorkspaceMetadata
{
	const workspaceMetaPath = join(storagePath, "workspace.json");
	if (!existsSync(workspaceMetaPath))
	{
		return {
			workspaceMetaStatus: "missing",
			workspaceUri: null,
			workspacePath: null,
		};
	}

	try
	{
		const parsed = JSON.parse(readFileSync(workspaceMetaPath, "utf-8")) as VSCodeWorkspaceMeta;
		const workspaceUri = typeof parsed.workspace === "string"
			? parsed.workspace.trim()
			: typeof parsed.folder === "string"
				? parsed.folder.trim()
				: "";
		if (!workspaceUri)
		{
			return {
				workspaceMetaStatus: "malformed",
				workspaceUri: null,
				workspacePath: null,
			};
		}

		return {
			workspaceMetaStatus: "ok",
			workspaceUri,
			workspacePath: decodeVSCodeFileUri(workspaceUri),
		};
	}
	catch
	{
		return {
			workspaceMetaStatus: "malformed",
			workspaceUri: null,
			workspacePath: null,
		};
	}
}

