/**
 * Runtime holder for AgentBuilder, AgentPublisher, and live cc.json refresh after Add Vault.
 *
 * Architecture: server/zz-reach2/architecture/agents/archi-agent-builder.md
 * Upgrade: server/zz-reach2/upgrades/2026-06/r2ap-agent-publisher-2.md (Part B)
 */

import type { MachineConfig } from "../types.js";
import { AgentBuilder, type PrepareResponse } from "./AgentBuilder.js";
import { AgentPublisher } from "../agentPublisher/AgentPublisher.js";
import { CanonicalAgentStore } from "../agentPublisher/CanonicalAgentStore.js";
import {
	mapCanonicalAgentList,
	type AgentListResponse,
	type PublishStatusResponse,
} from "../agentPublisher/canonicalListMapper.js";
import type { CanonicalAgentDefinition } from "../agentPublisher/types.js";
import { createVaultDataSource, updateVaultDataSource, type CreateVaultDataSourceResult, type UpdateVaultInput } from "./dataSourceMutation.js";
import type { AddVaultInput } from "./vaultDefaults.js";
import { getLogger } from "../logging/logger.js";

const logger = getLogger("agentBuilder:runtime");

/** Response from POST /api/agent-builder/vaults and PATCH /api/agent-builder/vaults. */
export type AddVaultResponse = {
	entry: CreateVaultDataSourceResult["entry"];
	category: string;
	configPath: string;
	prepare: PrepareResponse;
	/** Present after PATCH when the vault display name changed. */
	previousName?: string;
};

/**
 * Owns canonical store, optional Builder/Publisher instances, and refresh after cc.json mutation.
 * Vault routes remain available even when no AgentBuilder sources existed at startup.
 */
export class AgentBuilderRuntime
{
	private agentBuilder?: AgentBuilder;
	private agentPublisher?: AgentPublisher;
	private machine: MachineConfig;

	/**
	 * @param configPath - Absolute path to cc.json for Add Vault writes.
	 * @param storagePath - CXC storage root for canonical store and publish ledger.
	 * @param canonicalStore - Shared canonical definition persistence.
	 * @param initialMachine - Machine row selected at startup for this host.
	 */
	constructor(
		private readonly configPath: string,
		private readonly storagePath: string,
		private readonly canonicalStore: CanonicalAgentStore,
		initialMachine: MachineConfig,
	)
	{
		this.machine = initialMachine;
	}

	/** Current machine config row (updated after Add Vault). */
	getMachine(): MachineConfig
	{
		return this.machine;
	}

	/** Live AgentBuilder instance when sources exist. */
	getAgentBuilder(): AgentBuilder | undefined
	{
		return this.agentBuilder;
	}

	/** Live AgentPublisher instance when sources exist. */
	getAgentPublisher(): AgentPublisher | undefined
	{
		return this.agentPublisher;
	}

	/** Canonical definition store shared by Builder save and Agent List. */
	getCanonicalStore(): CanonicalAgentStore
	{
		return this.canonicalStore;
	}

	/**
	 * Bootstraps Builder/Publisher when AgentBuilder sources are configured.
	 * @param machine - Machine config row containing dataSources.
	 */
	async initializeFromMachine(machine: MachineConfig): Promise<void>
	{
		this.machine = machine;
		const sources = AgentBuilder.extractAgentBuilderSourcesFromMachine(machine);
		if (sources.length === 0)
		{
			this.agentBuilder = undefined;
			this.agentPublisher = undefined;
			return;
		}

		this.agentBuilder = new AgentBuilder(machine, this.canonicalStore, this.storagePath);
		await this.agentBuilder.index();
		this.agentPublisher = new AgentPublisher(
			sources,
			this.storagePath,
			this.agentBuilder,
			(sourceName, artifacts) => this.agentBuilder!.upsertPublishedArtifacts(sourceName, artifacts),
			this.canonicalStore,
		);
		logger.info(`AgentBuilderRuntime initialized with ${sources.length} source(s).`);
	}

	/**
	 * Returns canonical-first Agent List joined with publish ledger rows.
	 * Does not scan disk artifacts to decide catalog membership.
	 */
	listCanonicalAgents(): AgentListResponse
	{
		const definitions = this.canonicalStore.list();
		const ledger = this.agentPublisher?.getPublishLedger()
			?? this.agentBuilder?.getPublishLedgerForList();

		const byId = new Map<string, ReturnType<NonNullable<typeof ledger>["getByCanonicalId"]>>();
		if (ledger)
		{
			// Business logic: group ledger rows once so list mapping stays O(definitions + ledger) without per-row scans.
			for (const def of definitions)
			{
				byId.set(def.id, ledger.getByCanonicalId(def.id));
			}
		}

		return mapCanonicalAgentList(definitions, byId, true);
	}

	/**
	 * Loads one canonical definition by id from the store.
	 * @param canonicalId - Stable canonical definition id.
	 */
	getCanonicalDefinition(canonicalId: string): CanonicalAgentDefinition | undefined
	{
		return this.canonicalStore.get(canonicalId);
	}

	/**
	 * Returns publish status and optional full drift for Publisher dialog open.
	 * @param canonicalId - Canonical definition id to inspect.
	 */
	getPublishStatus(canonicalId: string): PublishStatusResponse
	{
		const definition = this.canonicalStore.get(canonicalId);
		if (!definition)
		{
			throw Object.assign(new Error(`No canonical definition found for id "${canonicalId}"`), { status: 404 });
		}

		const ledger = this.agentPublisher?.getPublishLedger()
			?? this.agentBuilder?.getPublishLedgerForList();
		const rows = ledger?.getByCanonicalId(canonicalId) ?? [];
		const publishedTo = rows.map((row) => ({
			platform: row.platform,
			artifactKind: row.artifactKind,
			absolutePath: row.absolutePath,
			publishedAt: row.publishedAt,
			artifactFormat: row.artifactFormat,
			actualLinkStrategy: row.actualLinkStrategy,
			...(row.platform === "codex" ? { codexEntryId: row.canonicalId } : {}),
		}));

		const response: PublishStatusResponse = { canonicalId, publishedTo };
		if (this.agentPublisher)
		{
			response.drift = this.agentPublisher.detectDrift(canonicalId, definition);
		}
		return response;
	}

	/**
	 * Persists a new vault data source, reloads machine config, and refreshes Builder/Publisher inventories.
	 * Business logic: indexing begins only here (after POST /vaults) — Vault Explorer browse routes must stay read-only.
	 * @param machineName - machines[].machine name to mutate in cc.json.
	 * @param input - Save Vault request body.
	 */
	async addVault(machineName: string, input: AddVaultInput): Promise<AddVaultResponse>
	{
		const result = createVaultDataSource(this.configPath, machineName, input, { backup: true });
		this.machine = result.machine;
		await this.initializeFromMachine(this.machine);

		const prepare = this.agentBuilder?.prepare()
			?? { totalFiles: 0, sources: [], files: [] };

		return {
			entry: result.entry,
			category: result.category,
			configPath: result.configPath,
			prepare,
		};
	}

	/**
	 * Updates vault metadata in cc.json and refreshes the in-memory AgentBuilder inventory.
	 * Business logic: metadata-only PATCH keeps the same path — initializeFromMachine reloads config without adding a new source row.
	 * @param machineName - machines[].machine name to mutate in cc.json.
	 * @param input - PATCH body keyed by existing vault path.
	 */
	async updateVault(machineName: string, input: UpdateVaultInput): Promise<AddVaultResponse>
	{
		const result = updateVaultDataSource(this.configPath, machineName, input, { backup: true });
		this.machine = result.machine;
		await this.initializeFromMachine(this.machine);

		const prepare = this.agentBuilder?.prepare()
			?? { totalFiles: 0, sources: [], files: [] };

		return {
			entry: result.entry,
			category: result.category,
			configPath: result.configPath,
			prepare,
			previousName: result.previousName,
		};
	}
}
