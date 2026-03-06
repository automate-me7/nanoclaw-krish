/**
 * ChromaDB Vector Store for NanoClaw (Tier 4 Memory)
 * Provides semantic search over conversation history, voice transcripts,
 * and daily digests using ChromaDB's built-in embeddings.
 */

import { CHROMA_HOST, CHROMA_PORT } from './config.js';
import { logger } from './logger.js';

const COLLECTION_NAME = 'nanoclaw_memory';
const CHUNK_SIZE = 500; // characters per chunk
const CHUNK_OVERLAP = 50;

interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string>;
}

interface ChromaQueryResult {
  ids: string[][];
  documents: (string | null)[][];
  metadatas: (Record<string, string> | null)[][];
  distances: number[][];
}

let chromaBaseUrl = '';
let initialized = false;

/**
 * Initialize ChromaDB connection and ensure collection exists.
 */
export async function initChromaDB(): Promise<void> {
  chromaBaseUrl = `${CHROMA_HOST}:${CHROMA_PORT}`;

  try {
    // Health check
    const heartbeat = await fetch(`${chromaBaseUrl}/api/v1/heartbeat`);
    if (!heartbeat.ok) {
      throw new Error(`ChromaDB heartbeat failed: ${heartbeat.status}`);
    }

    // Create or get collection (using default embedding function)
    const res = await fetch(`${chromaBaseUrl}/api/v1/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: COLLECTION_NAME,
        get_or_create: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create collection: ${res.status} ${body}`);
    }

    initialized = true;
    logger.info(
      { url: chromaBaseUrl, collection: COLLECTION_NAME },
      'ChromaDB initialized',
    );
  } catch (err) {
    logger.error(
      { err, url: chromaBaseUrl },
      'Failed to initialize ChromaDB — vector store disabled',
    );
    initialized = false;
  }
}

/**
 * Check if ChromaDB is available.
 */
export function isChromaAvailable(): boolean {
  return initialized;
}

/**
 * Split text into overlapping chunks for embedding.
 */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (start + CHUNK_OVERLAP >= text.length) break;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Get the collection ID for API calls.
 */
async function getCollectionId(): Promise<string | null> {
  try {
    const res = await fetch(
      `${chromaBaseUrl}/api/v1/collections/${COLLECTION_NAME}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

/**
 * Ingest a document into ChromaDB with metadata.
 * Chunks text and upserts into the collection.
 */
export async function ingestDocument(
  text: string,
  metadata: {
    source: string;
    group_folder: string;
    type: string;
    timestamp?: string;
  },
): Promise<void> {
  if (!initialized) return;

  const collectionId = await getCollectionId();
  if (!collectionId) {
    logger.warn('ChromaDB collection not found, skipping ingestion');
    return;
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) return;

  const ts = metadata.timestamp || new Date().toISOString();
  const baseId = `${metadata.group_folder}-${metadata.type}-${Date.now()}`;

  const ids = chunks.map((_, i) => `${baseId}-${i}`);
  const documents = chunks;
  const metadatas = chunks.map((_, i) => ({
    ...metadata,
    timestamp: ts,
    chunk_index: String(i),
    total_chunks: String(chunks.length),
  }));

  try {
    const res = await fetch(
      `${chromaBaseUrl}/api/v1/collections/${collectionId}/upsert`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, documents, metadatas }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'ChromaDB upsert failed');
      return;
    }

    logger.debug(
      {
        group: metadata.group_folder,
        type: metadata.type,
        chunks: chunks.length,
      },
      'Document ingested into ChromaDB',
    );
  } catch (err) {
    logger.warn({ err }, 'ChromaDB ingestion error');
  }
}

/**
 * Semantic search across the vector store.
 */
export async function semanticSearch(
  query: string,
  nResults: number = 5,
  filterMetadata?: Record<string, string>,
): Promise<
  Array<{
    document: string;
    metadata: Record<string, string>;
    distance: number;
  }>
> {
  if (!initialized) return [];

  const collectionId = await getCollectionId();
  if (!collectionId) return [];

  try {
    const body: Record<string, unknown> = {
      query_texts: [query],
      n_results: nResults,
    };

    if (filterMetadata && Object.keys(filterMetadata).length > 0) {
      body.where = filterMetadata;
    }

    const res = await fetch(
      `${chromaBaseUrl}/api/v1/collections/${collectionId}/query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, 'ChromaDB query failed');
      return [];
    }

    const data = (await res.json()) as ChromaQueryResult;

    const results: Array<{
      document: string;
      metadata: Record<string, string>;
      distance: number;
    }> = [];

    if (data.ids?.[0]) {
      for (let i = 0; i < data.ids[0].length; i++) {
        results.push({
          document: data.documents?.[0]?.[i] || '',
          metadata: data.metadatas?.[0]?.[i] || {},
          distance: data.distances?.[0]?.[i] || 0,
        });
      }
    }

    return results;
  } catch (err) {
    logger.warn({ err }, 'ChromaDB search error');
    return [];
  }
}

/**
 * Ingest a conversation into the vector store.
 */
export async function ingestConversation(
  messages: Array<{ sender_name: string; content: string; timestamp: string }>,
  groupFolder: string,
): Promise<void> {
  if (!initialized || messages.length === 0) return;

  const text = messages
    .map((m) => `[${m.sender_name}]: ${m.content}`)
    .join('\n');

  await ingestDocument(text, {
    source: 'conversation',
    group_folder: groupFolder,
    type: 'conversation',
    timestamp: messages[messages.length - 1].timestamp,
  });
}

/**
 * Ingest a daily digest into the vector store.
 */
export async function ingestDailyDigest(
  digest: string,
  groupFolder: string,
): Promise<void> {
  if (!initialized) return;

  await ingestDocument(digest, {
    source: 'daily_digest',
    group_folder: groupFolder,
    type: 'daily_digest',
  });
}

/**
 * Ingest a voice transcript into the vector store.
 */
export async function ingestVoiceTranscript(
  transcript: string,
  metadata: { group_folder: string; sender?: string },
): Promise<void> {
  if (!initialized) return;

  await ingestDocument(transcript, {
    source: 'voice_transcript',
    group_folder: metadata.group_folder,
    type: 'voice_transcript',
  });
}
