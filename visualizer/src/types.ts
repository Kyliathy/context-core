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

export type ViewType = "search" | "search-threads" | "latest" | "favorites" | "agent-builder" | "agent-list" | "template-create" | "template-list";

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
	platform: "github" | "claude" | "codex";
};

/** Response from POST /api/agent-builder/create. */
export type CreateAgentResponse = {
	created: boolean;
	path: string;
	agentName: string;
	codexEntryId?: string;
};

/** Per-platform location info within a consolidated agent list entry. */
export type AgentListPlatformEntry = {
	platform: "github" | "claude" | "codex";
	path: string;
	codexEntryId?: string;
	codexDirectory?: string;
	dataLength: number;
};

/** Summary entry for GET /api/agent-builder/list (consolidated across platforms). */
export type AgentListEntry = {
	name: string;
	path: string;
	codexEntryId?: string;
	codexDirectory?: string;
	platform?: "github" | "claude" | "codex";
	platforms: AgentListPlatformEntry[];
	contentDiverged: boolean;
	description: string;
	hint: string;
	excerpt: string;
};

/** Response from GET /api/agent-builder/list. */
export type AgentListResponse = {
	totalAgents: number;
	agents: AgentListEntry[];
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
	agentPath: string;
	codexEntryId?: string;
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
	platforms?: AgentListPlatformEntry[];
	contentDiverged?: boolean;
	/** File size in bytes (agent-builder file cards only). */
	fileSize?: number;
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
