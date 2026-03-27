import type { Express } from "express";
import type { RouteContext } from "../RouteContext.js";
import { loadProjectRemapsByHarness, applyProjectRemap } from "../routeUtils.js";

export function register(app: Express, ctx: RouteContext): void
{
	app.get("/api/projects", (_req, res) =>
	{
		const remapsByHarness = loadProjectRemapsByHarness();
		const mapped = ctx.messageDB.getProjectsByHarness().map(({ harness, projects }) =>
		{
			const remappedProjects = Array.from(
				new Set(projects.map((project) => applyProjectRemap(harness, project, remapsByHarness)))
			).sort((a, b) => a.localeCompare(b));
			return {
				harness,
				projects: remappedProjects,
			};
		});

		res.json(mapped);
	});
}
