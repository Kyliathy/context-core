import type { IMessageStore } from "../db/IMessageStore.js";
import type { EmbeddingService } from "../vector/EmbeddingService.js";
import type { QdrantService } from "../vector/QdrantService.js";
import type { TopicStore } from "../settings/TopicStore.js";
import type { AgentBuilder } from "../agentBuilder/AgentBuilder.js";
import type { ScopeStore } from "../settings/ScopeStore.js";
import type { SummaryEmbeddingCache } from "../vector/SummaryEmbeddingCache.js";

export interface RouteContext
{
	messageDB: IMessageStore;
	topicStore?: TopicStore;
	scopeStore?: ScopeStore;
	agentBuilder?: AgentBuilder;
	summaryEmbeddingCache?: SummaryEmbeddingCache;
	vectorServices?: {
		embeddingService: EmbeddingService;
		qdrantService: QdrantService;
	};
}
