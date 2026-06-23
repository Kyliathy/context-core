export type AgentRole = "user" | "assistant" | "tool" | "system";

export type ToolCall = {
	name: string;
	context: string[];
	results: string[];
};

export type TokenUsage = {
	input: number | null;
	output: number | null;
};

export type SerializedAgentMessage = {
	id: string;
	sessionId: string;
	harness: string;
	machine: string;
	role: AgentRole;
	model: string | null;
	message: string;
	subject: string;
	context: string[];
	symbols: string[];
	history: string[];
	tags: string[];
	project: string;
	parentId: string | null;
	tokenUsage: TokenUsage | null;
	toolCalls: ToolCall[];
	rationale: string[];
	source: string;
	dateTime: string;
};

export type SerializedAgentThread = {
	sessionId: string;
	subject: string;
	harness: string;
	project: string;
	messageCount: number;
	totalLength: number;
	firstDateTime: string;
	lastDateTime: string;
	firstMessage: string;
	matchingMessageIds: string[];
	bestMatchScore: number;
	hits: number;
};

export type SearchHit = {
	score: number;
	hits: number;
	message: SerializedAgentMessage;
};

export type ThreadSearchResponse = {
	total: number;
	page: number;
	results: SerializedAgentThread[];
};

export type ViewType = "search" | "search-threads" | "latest" | "favorites" | "agent-builder" | "agent-list" | "template-create" | "template-list" | "vault-manager";

/** How Favorites-type views place cards on the map. */
export type CardPositioningMode = "Auto" | "CustomCardPositioning";

/** Persisted world-space origin for a favorite row (CustomCardPositioning). */
export type FavoriteEntryPosition = {
	x: number;
	y: number;
};

/** A single file indexed by the server's AgentBuilder. */
export type IndexedFile = {
	relativePath: string;
	absolutePath: string;
	size: number;
	lastModified: string;
	sourceName: string;
	sourceType: string;
	origin: "content" | "agent";
	/** First ~1000 characters of the file content, provided by the server. */
	excerpt?: string;
};

/** Response from POST /api/agent-builder/prepare. */
export type PrepareResponse = {
	totalFiles: number;
	sources: {
		name: string;
		type: string;
		path: string;
		agentPath?: string;
		codexDirectories?: string[];
		codexDefaultDirectory?: string;
		fileCount: number;
	}[];
	files: IndexedFile[];
};

/** A single knowledge entry in the AgentBasket. */
export type AgentKnowledgeEntry = {
	/** Unique ID for React key + reorder operations. */
	id: string;
	/** Either a file relativePath or custom text. */
	value: string;
	/** "file" = from card save, "custom" = from textarea, "placeholder" = template placeholder token. */
	kind: "file" | "custom" | "placeholder";
	/** Data source name (only for kind="file"). */
	sourceName?: string;
	/** Timestamp when added. */
	addedAt: number;
	/** Index in original template agentKnowledge (for placeholder restore). */
	placeholderIndex?: number;
	/** File size in bytes (only for kind="file" entries sourced from agent-builder cards). */
	fileSizeBytes?: number;
};

/** Mirrors server's CreateTemplateInput. */
export type CreateTemplateInput = {
	templateName: string;
	description: string;
	"argument-hint": string;
	tools?: string[];
	agentKnowledge: string[];
};

/** Response from POST /api/agent-builder/add-template. */
export type CreateTemplateResponse = {
	created: boolean;
	templateName: string;
	path: string;
};

/** Response from GET /api/agent-builder/list-templates. */
export type TemplateListResponse = {
	totalTemplates: number;
	templates: CreateTemplateInput[];
};

/** Input for POST /api/agent-builder/create (mirrors server type). */
export type CreateAgentInput = {
	projectName: string;
	agentName: string;
	description: string;
	"argument-hint": string;
	tools?: string[];
	agentKnowledge: string[];
	codexEntryId?: string;
	codexDirectory?: string;
	/** Legacy platform-specific create; omit for canonical-only save. */
	platform?: "github" | "claude" | "codex";
	/** Preserve catalog id when saving an edited canonical definition. */
	canonicalId?: string;
};

/** Response from POST /api/agent-builder/create. */
export type CreateAgentResponse = {
	created: boolean;
	agentName: string;
	path?: string;
	canonicalId?: string;
	canonicalDefinition?: CanonicalAgentDefinition;
	/** True when canonical-only create persisted to server store. */
	persisted?: boolean;
	/** Absolute path to agent-definitions.json when canonical-only create succeeded. */
	canonicalStoragePath?: string;
	codexEntryId?: string;
};

/** Publish platform identifiers (mirrors server AgentPublisher). */
export type PublishPlatform = "copilot" | "claude" | "codex" | "kiro" | "cursor" | "windsurf" | "antigravity";

export type ArtifactKind = "agent" | "skill";

export type KnowledgeRef = {
	kind: "file" | "text";
	value: string;
};

export type CanonicalAgentDefinition = {
	id: string;
	kind: ArtifactKind;
	projectName: string;
	name: string;
	description: string;
	whenToUse?: string;
	"argument-hint"?: string;
	tools?: string[];
	knowledge: KnowledgeRef[];
	body?: string;
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	paths?: string[];
	disableModelInvocation?: boolean;
	/** Append-only publish history for Publisher "Already published" UI. */
	publishedArtifacts?: CanonicalPublishedArtifact[];
};

/** One historical publish record stored on agent-definitions.json. */
export type CanonicalPublishedArtifact = {
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	absolutePath: string;
	publishedAt: string;
	linkStrategy?: LinkStrategy;
};

export type LinkStrategy = "copy" | "import-shim" | "symlink";

export type PublishTarget = {
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	outputDir: string;
	codexEntryId?: string;
	linkStrategy?: LinkStrategy;
};

export type RenderedArtifactPreview = {
	absolutePath: string;
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	previewStatus?: "new" | "replace-generated" | "backup-unmanaged" | "unknown";
	materialization?: {
		requestedLinkStrategy?: LinkStrategy;
		actualLinkStrategy?: LinkStrategy;
	};
};

export type PreviewResult = {
	artifacts: RenderedArtifactPreview[];
	warnings: string[];
	errors: string[];
};

export type PublishResult = {
	written: Array<{ absolutePath: string; platform: PublishPlatform; artifactKind: ArtifactKind }>;
	warnings: string[];
	errors: string[];
};

export type DirHeatNode = {
	name: string;
	absolutePath: string;
	directHits: number;
	subtreeHits: number;
	heat: number;
	children: DirHeatNode[];
};

export type PathHeatResult = {
	projectName: string;
	projectRoot: string;
	totalHits: number;
	tree: DirHeatNode[];
	topPaths: Array<{ path: string; hits: number }>;
	suggestedOutputDir?: string;
	droppedPathCount: number;
	/** Absolute paths of knowledge basket files included in this analysis. */
	knowledgeFilePaths?: string[];
	/** Per-markdown-source placement attribution for Publisher chip UI. */
	mdSources?: PlacementMdSource[];
};

export type PlacementMdSource = {
	absolutePath: string;
	displayPath: string;
	inBasket: boolean;
	isRelated: boolean;
	directoryPaths: Array<{ absolutePath: string; hits: number }>;
};

export type PlatformDefaultDirs = {
	projectRoot: string;
	agentOutputDir: string;
	skillRootDir: string;
};

export type PlatformArtifactTemplate = {
	artifactKind: ArtifactKind;
	rootKey: "agentOutputDir" | "skillRootDir" | "projectRoot";
	relativePathTemplate: string;
	note?: string;
};

export type PlatformCapability = {
	platform: PublishPlatform;
	label: string;
	supportedArtifactKinds: ArtifactKind[];
	defaultDirs?: PlatformDefaultDirs;
	artifactTemplates?: PlatformArtifactTemplate[];
	notes?: string[];
	/** @deprecated Prefer supportedLinkStrategiesByKind */
	supportedLinkStrategies?: LinkStrategy[];
	/** Per-artifact-kind link strategies exposed to the Publisher UI. */
	supportedLinkStrategiesByKind?: Partial<Record<ArtifactKind, LinkStrategy[]>>;
};

export type DriftReport = {
	canonicalId: string;
	entries: Array<{
		platform: PublishPlatform;
		artifactKind: ArtifactKind;
		absolutePath: string;
		state: "clean" | "canonical-changed" | "disk-changed" | "missing-file" | "unknown";
	}>;
};

/** Per-platform publish summary on a canonical Agent List card. */
export type PublishedTargetSummary = {
	platform: PublishPlatform;
	artifactKind: ArtifactKind;
	absolutePath: string;
	publishedAt: string;
	artifactFormat?: string;
	actualLinkStrategy?: LinkStrategy;
	codexEntryId?: string;
	state?: "clean" | "disk-changed" | "missing-file" | "canonical-changed" | "unknown";
};

/**
 * Canonical Agent List entry — backed by agent-definitions.json, not disk artifact scans.
 * Disk files are publish output joined through publishedTo.
 */
export type AgentListEntry = {
	canonicalId: string;
	projectName: string;
	name: string;
	description: string;
	hint: string;
	kind: ArtifactKind;
	savedAt?: string;
	publishedTo: PublishedTargetSummary[];
	unpublished: boolean;
};

/** Response from GET /api/agent-builder/list. */
export type AgentListResponse = {
	totalAgents: number;
	agents: AgentListEntry[];
};

export type PublishStatusResponse = {
	canonicalId: string;
	publishedTo: PublishedTargetSummary[];
	publishedArtifacts?: CanonicalPublishedArtifact[];
	drift?: DriftReport;
};

/** Full agent definition returned by GET /api/agent-builder/get-agent. */
export type AgentDefinition = CreateAgentInput & {
	fromJson: boolean;
};

/** Response from GET /api/agent-builder/get-agent. */
export type GetAgentResponse = {
	agent: AgentDefinition;
};

/** Emitted by D3 engine when user clicks ✏️ on an agent-list card. */
export type CardEditAgentEventDetail = {
	cardId: string;
	canonicalId: string;
};

export type CardPublishAgentEventDetail = {
	cardId: string;
	canonicalId: string;
};

export type CardUseTemplateEventDetail = {
	cardId: string;
	templateName: string;
};

export type ViewDefinition = {
	id: string;
	name: string;
	type: ViewType;
	emoji: string;
	color: string;
	query: string;
	autoQuery: boolean;
	autoRefreshSeconds: number;
	createdAt: number;
	projects?: SelectedProject[];
	symbols?: string;
	subject?: string;
	/** Favorites views only: Auto masonry vs drag-placed custom coordinates. */
	cardPositioningMode?: CardPositioningMode;
};

export type ProjectGroup = {
	harness: string;
	projects: string[];
};

export type SelectedProject = {
	harness: string;
	project: string;
};

export type Scope = {
	id: string;
	name: string;
	emoji: string;
	color: string;
	projectIds: SelectedProject[];
};

export type FavoriteSource =
	| { type: "message"; data: SerializedAgentMessage }
	| { type: "thread"; data: SerializedAgentThread };

export type FavoriteEntry = {
	cardId: string;
	viewId: string;
	source: FavoriteSource;
	addedAt: number;
	/** World-space position when the owning view uses CustomCardPositioning. */
	position?: FavoriteEntryPosition;
};

/** Compact favorites-type view row stored next to FavoriteEntry rows for server JSON and sync UI. */
export type FavoriteViewSnapshot = {
	id: string;
	name: string;
	emoji: string;
	color: string;
	cardPositioningMode?: CardPositioningMode;
};

export type FilterState = {
	roles: Set<AgentRole>;
	minScore: number;
};

export type SymbolEntry = {
	label: string;
	color: string;
};

export type CardData = {
	id: string;
	sessionId: string;
	x: number;
	y: number;
	w: number;
	h: number;
	title: string;
	harness: string;
	project: string;
	model: string | null;
	role: AgentRole;
	dateTime: string;
	score: number;
	hits: number;
	symbols: SymbolEntry[];
	excerptShort: string;
	excerptMedium: string;
	excerptLong: string;
	source: SerializedAgentMessage;
	customColor?: string;
	customEmoji?: string;
	agentPath?: string;
	codexEntryId?: string;
	canonicalId?: string;
	publishedTo?: PublishedTargetSummary[];
	unpublished?: boolean;
	/** File size in bytes (agent-builder file cards only). */
	fileSize?: number;
	/** When built from Favorites: use taller min height so vertical action buttons are not clipped at high zoom. */
	favoriteSource?: boolean;
	/** Persisted favorite position (CustomCardPositioning); layout engine merges with auto fallback for missing rows. */
	layoutPosition?: FavoriteEntryPosition;
};

export type ThreadCardData = {
	id: string;
	sessionId: string;
	x: number;
	y: number;
	w: number;
	h: number;
	title: string;
	harness: string;
	project: string;
	messageCount: number;
	totalLength: number;
	firstDateTime: string;
	lastDateTime: string;
	matchCount: number;
	matchingMessageIds: string[];
	score: number;
	hits: number;
	source: SerializedAgentThread;
	favoriteSource?: boolean;
	layoutPosition?: FavoriteEntryPosition;
};

/** Emitted when a favorite card is drag-repositioned (CustomCardPositioning). */
export type CardPositionChangeEventDetail = {
	viewId: string;
	cardId: string;
	kind: "message" | "thread";
	x: number;
	y: number;
};

export type MasterCardData = {
	id: string;                 // scope id or "project::{harness}::{project}"
	label: string;              // display name
	emoji: string;              // scope emoji or ""
	color: string;              // border color (scope color or palette)
	kind: "scope" | "project";
	cards: CardData[];
	threads: ThreadCardData[];
	x: number;
	y: number;
	w: number;
	h: number;
};

export type HoverEventDetail = {
	phase: "enter" | "move" | "leave";
	data: CardData;
	localX: number;
	localY: number;
	pageX: number;
	pageY: number;
};

export type ViewportChangeDetail = {
	x: number;
	y: number;
	k: number;
};

export type BasketLine = {
	id: string;
	text: string;
	cardId: string;
	addedAt: number;
};

export type LineClickEventDetail = {
	text: string;
	cardId: string;
	lineIndex: number;
};

export type CardStarEventDetail = {
	cardId: string;
	source: FavoriteSource;
};

/** Response from GET /api/agent-builder/get-file-content. */
export type FileContentResponse = {
	relativePath: string;
	absolutePath: string;
	content: string;
	size: number;
	sourceName: string;
	sourceType: string;
};

/** Emitted by D3 engine when user clicks add-knowledge on a card in agent-builder view. */
export type CardAddKnowledgeEventDetail = {
	cardId: string;
	relativePath: string;
	sourceName: string;
	/** Harness value of the card (e.g. "AgentFile" | "ContentFile"). Present in agent-builder mode. */
	harness?: string;
	/** File size in bytes (present for agent-builder file cards). */
	fileSizeBytes?: number;
};

export type TitleClickEventDetail = {
	sessionId: string;
	messageId: string;
};
