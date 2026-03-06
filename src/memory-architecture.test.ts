/**
 * 4-Tier Memory Architecture — Automated Tests
 *
 * Injects sample data into each memory tier and verifies retrieval,
 * isolation, and search capabilities work correctly.
 *
 * Tier 1 — Active Context: Native Claude context window (not unit-testable)
 * Tier 2 — Per-Contact Message History: SQLite `messages` table
 * Tier 3 — Business Facts: SQLite `business_facts` table
 * Tier 4 — Semantic Search: ChromaDB chunking + graceful degradation
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
    _initTestDatabase,
    storeMessageDirect,
    storeChatMetadata,
    getMessagesSince,
    getNewMessages,
    upsertBusinessFact,
    getBusinessFact,
    getBusinessFactsByCategory,
    getAllBusinessFacts,
    searchBusinessFacts,
    deleteBusinessFact,
} from './db.js';

import {
    chunkText,
    isChromaAvailable,
    ingestDocument,
    semanticSearch,
} from './chromadb.js';

// ──────────────────────────────────────────────
// Tier 2 — Per-Contact Message History
// ──────────────────────────────────────────────

describe('Tier 2: Per-Contact Message History', () => {
    beforeEach(() => {
        _initTestDatabase();
    });

    it('stores a message and retrieves it by JID and timestamp', () => {
        storeChatMetadata('group-a@g.us', '2026-03-06T10:00:00Z', 'Group A', 'whatsapp', true);

        storeMessageDirect({
            id: 'msg-001',
            chat_jid: 'group-a@g.us',
            sender: 'user1@s.whatsapp.net',
            sender_name: 'Alice',
            content: 'Hello from Alice',
            timestamp: '2026-03-06T10:00:00Z',
            is_from_me: false,
        });

        const messages = getMessagesSince(
            'group-a@g.us',
            '2026-03-06T09:00:00Z',
            'Andy',
        );

        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('Hello from Alice');
        expect(messages[0].sender_name).toBe('Alice');
    });

    it('isolates messages per chat JID — Group A does not see Group B messages', () => {
        storeChatMetadata('group-a@g.us', '2026-03-06T10:00:00Z', 'Group A', 'whatsapp', true);
        storeChatMetadata('group-b@g.us', '2026-03-06T10:00:00Z', 'Group B', 'whatsapp', true);

        storeMessageDirect({
            id: 'msg-a1',
            chat_jid: 'group-a@g.us',
            sender: 'alice@s.whatsapp.net',
            sender_name: 'Alice',
            content: 'Secret message for Group A',
            timestamp: '2026-03-06T10:00:00Z',
            is_from_me: false,
        });

        storeMessageDirect({
            id: 'msg-b1',
            chat_jid: 'group-b@g.us',
            sender: 'bob@s.whatsapp.net',
            sender_name: 'Bob',
            content: 'Secret message for Group B',
            timestamp: '2026-03-06T10:01:00Z',
            is_from_me: false,
        });

        const groupAMessages = getMessagesSince('group-a@g.us', '2026-03-06T09:00:00Z', 'Andy');
        const groupBMessages = getMessagesSince('group-b@g.us', '2026-03-06T09:00:00Z', 'Andy');

        expect(groupAMessages).toHaveLength(1);
        expect(groupAMessages[0].content).toBe('Secret message for Group A');
        expect(groupBMessages).toHaveLength(1);
        expect(groupBMessages[0].content).toBe('Secret message for Group B');
    });

    it('getNewMessages filters bot messages by prefix', () => {
        storeChatMetadata('group-a@g.us', '2026-03-06T10:00:00Z', 'Group A', 'whatsapp', true);

        storeMessageDirect({
            id: 'msg-user',
            chat_jid: 'group-a@g.us',
            sender: 'user@s.whatsapp.net',
            sender_name: 'User',
            content: 'What is the weather?',
            timestamp: '2026-03-06T10:00:00Z',
            is_from_me: false,
        });

        storeMessageDirect({
            id: 'msg-bot',
            chat_jid: 'group-a@g.us',
            sender: 'bot@s.whatsapp.net',
            sender_name: 'Andy',
            content: 'Andy: The weather is sunny',
            timestamp: '2026-03-06T10:00:01Z',
            is_from_me: true,
            is_bot_message: true,
        });

        const { messages } = getNewMessages(
            ['group-a@g.us'],
            '2026-03-06T09:00:00Z',
            'Andy:',
        );

        const userMessages = messages.filter((m) => !m.is_from_me);
        expect(userMessages).toHaveLength(1);
        expect(userMessages[0].content).toBe('What is the weather?');
    });

    it('retrieves multiple messages in chronological order', () => {
        storeChatMetadata('group-a@g.us', '2026-03-06T10:00:00Z', 'Group A', 'whatsapp', true);

        const timestamps = [
            '2026-03-06T10:00:00Z',
            '2026-03-06T10:05:00Z',
            '2026-03-06T10:10:00Z',
        ];

        timestamps.forEach((ts, i) => {
            storeMessageDirect({
                id: `msg-${i}`,
                chat_jid: 'group-a@g.us',
                sender: 'user@s.whatsapp.net',
                sender_name: 'Alice',
                content: `Message ${i + 1}`,
                timestamp: ts,
                is_from_me: false,
            });
        });

        const messages = getMessagesSince('group-a@g.us', '2026-03-06T09:00:00Z', 'Andy');

        expect(messages).toHaveLength(3);
        expect(messages[0].content).toBe('Message 1');
        expect(messages[2].content).toBe('Message 3');
    });
});

// ──────────────────────────────────────────────
// Tier 3 — Business Facts
// ──────────────────────────────────────────────

describe('Tier 3: Business Facts (Long-Term Memory)', () => {
    beforeEach(() => {
        _initTestDatabase();
    });

    it('upserts and retrieves a business fact by key', () => {
        upsertBusinessFact('q1_revenue_target', '$500,000', 'finance');

        const fact = getBusinessFact('q1_revenue_target');
        expect(fact).toBeDefined();
        expect(fact!.value).toBe('$500,000');
        expect(fact!.category).toBe('finance');
    });

    it('upsert overwrites existing key (no duplicates)', () => {
        upsertBusinessFact('ceo_name', 'Alice', 'contact');
        upsertBusinessFact('ceo_name', 'Bob', 'contact');

        const fact = getBusinessFact('ceo_name');
        expect(fact!.value).toBe('Bob');

        const all = getAllBusinessFacts();
        const ceoFacts = all.filter((f) => f.key === 'ceo_name');
        expect(ceoFacts).toHaveLength(1);
    });

    it('filters facts by category', () => {
        upsertBusinessFact('ceo_name', 'Alice', 'contact');
        upsertBusinessFact('cto_name', 'Bob', 'contact');
        upsertBusinessFact('product_name', 'NanoClaw', 'general');

        const contacts = getBusinessFactsByCategory('contact');
        expect(contacts).toHaveLength(2);
        expect(contacts.map((f) => f.key)).toContain('ceo_name');
        expect(contacts.map((f) => f.key)).toContain('cto_name');

        const general = getBusinessFactsByCategory('general');
        expect(general).toHaveLength(1);
        expect(general[0].key).toBe('product_name');
    });

    it('searches facts across key, value, and category', () => {
        upsertBusinessFact('q1_revenue', '$500,000', 'finance');
        upsertBusinessFact('preferred_color', 'blue', 'preference');
        upsertBusinessFact('finance_tool', 'QuickBooks', 'reference');

        const byValue = searchBusinessFacts('500');
        expect(byValue).toHaveLength(1);
        expect(byValue[0].key).toBe('q1_revenue');

        const byCategory = searchBusinessFacts('finance');
        expect(byCategory.length).toBeGreaterThanOrEqual(2);

        const byKey = searchBusinessFacts('color');
        expect(byKey).toHaveLength(1);
        expect(byKey[0].value).toBe('blue');
    });

    it('deletes a business fact', () => {
        upsertBusinessFact('temp_fact', 'delete me', 'general');
        expect(getBusinessFact('temp_fact')).toBeDefined();

        deleteBusinessFact('temp_fact');
        expect(getBusinessFact('temp_fact')).toBeUndefined();
    });

    it('getAllBusinessFacts returns all facts ordered by category then key', () => {
        upsertBusinessFact('zoo', 'animal place', 'general');
        upsertBusinessFact('alice_phone', '+1234', 'contact');
        upsertBusinessFact('bob_phone', '+5678', 'contact');

        const all = getAllBusinessFacts();
        expect(all).toHaveLength(3);
        expect(all[0].category).toBe('contact');
        expect(all[2].category).toBe('general');
    });
});

// ──────────────────────────────────────────────
// Tier 4 — Semantic Search (ChromaDB)
// ──────────────────────────────────────────────

describe('Tier 4: Semantic Search (ChromaDB)', () => {
    describe('chunkText — text splitting for embeddings', () => {
        it('splits long text into overlapping chunks', () => {
            const text = 'A'.repeat(1200);
            const chunks = chunkText(text);

            expect(chunks.length).toBeGreaterThan(1);
            chunks.forEach((chunk) => {
                expect(chunk.length).toBeLessThanOrEqual(500);
            });
        });

        it('produces overlapping chunks (50 char overlap)', () => {
            const text = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join('');
            const chunks = chunkText(text);

            if (chunks.length >= 2) {
                const endOfFirst = chunks[0].slice(-50);
                const startOfSecond = chunks[1].slice(0, 50);
                expect(endOfFirst).toBe(startOfSecond);
            }
        });

        it('returns a single chunk for short text', () => {
            const text = 'Short text under 500 chars';
            const chunks = chunkText(text);
            expect(chunks).toHaveLength(1);
            expect(chunks[0]).toBe(text);
        });

        it('returns empty array for empty or whitespace-only input', () => {
            expect(chunkText('')).toHaveLength(0);
            expect(chunkText('   ')).toHaveLength(0);
        });
    });

    describe('graceful degradation when ChromaDB is offline', () => {
        it('isChromaAvailable returns false when not initialized', () => {
            expect(isChromaAvailable()).toBe(false);
        });

        it('ingestDocument silently no-ops when not initialized', async () => {
            await expect(
                ingestDocument('test text', {
                    source: 'test',
                    group_folder: 'test-group',
                    type: 'conversation',
                }),
            ).resolves.toBeUndefined();
        });

        it('semanticSearch returns empty array when not initialized', async () => {
            const results = await semanticSearch('test query');
            expect(results).toEqual([]);
        });
    });
});
