/**
 * Senri CRM Integration — Automated Tests
 *
 * Tests the senri.ts module (token cache, senriGet helper, guard logic)
 * using injected mock data. Does NOT hit the real Senri API.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initSenri, isSenriConfigured, senriGet } from '../container/agent-runner/src/senri.js';

// ──────────────────────────────────────────────
// Credential Management
// ──────────────────────────────────────────────

describe('Senri: Credential Management', () => {
    beforeEach(() => {
        // Reset module state by reinitializing with empty
        // We'll call initSenri with real values in each test
    });

    it('isSenriConfigured returns false before init', () => {
        // Fresh import — nothing configured yet in this test file scope
        // After multiple inits, we test by initing with empty strings
        initSenri('', '');
        expect(isSenriConfigured()).toBe(false);
    });

    it('isSenriConfigured returns true after init with valid credentials', () => {
        initSenri('test-key', 'test-secret');
        expect(isSenriConfigured()).toBe(true);
    });

    it('isSenriConfigured returns false if only key is provided', () => {
        initSenri('test-key', '');
        expect(isSenriConfigured()).toBe(false);
    });

    it('isSenriConfigured returns false if only secret is provided', () => {
        initSenri('', 'test-secret');
        expect(isSenriConfigured()).toBe(false);
    });
});

// ──────────────────────────────────────────────
// senriGet — Token fetch + retry on 401
// ──────────────────────────────────────────────

describe('Senri: senriGet with mocked fetch', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('throws when not configured', async () => {
        initSenri('', '');
        await expect(senriGet('/open_api/v1/users')).rejects.toThrow(
            'Senri API not configured',
        );
    });

    it('fetches token and makes GET request', async () => {
        initSenri('my-key', 'my-secret');

        const mockFetch = vi.fn()
            // First call: auth token
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: 'tok-123' }),
            })
            // Second call: actual API response
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ users: [{ id: 1, name: 'Alice' }] }),
            });

        vi.stubGlobal('fetch', mockFetch);

        const result = await senriGet('/open_api/v1/users', { page: 1 });

        expect(result).toEqual({ users: [{ id: 1, name: 'Alice' }] });

        // Verify auth call
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const authCall = mockFetch.mock.calls[0];
        expect(authCall[0]).toContain('/open_api/v1/auth');
        expect(JSON.parse(authCall[1].body)).toEqual({
            api_key: 'my-key',
            api_secret: 'my-secret',
        });

        // Verify GET call has Bearer token
        const getCall = mockFetch.mock.calls[1];
        expect(getCall[0]).toContain('/open_api/v1/users');
        expect(getCall[0]).toContain('page=1');
        expect(getCall[1].headers.Authorization).toBe('Bearer tok-123');
    });

    it('retries once on 401 (expired token)', async () => {
        initSenri('my-key', 'my-secret');

        const mockFetch = vi.fn()
            // First call: initial auth
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: 'tok-old' }),
            })
            // Second call: GET returns 401
            .mockResolvedValueOnce({
                ok: false,
                status: 401,
                text: async () => 'Unauthorized',
            })
            // Third call: re-auth
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: 'tok-new' }),
            })
            // Fourth call: retry GET succeeds
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ products: [] }),
            });

        vi.stubGlobal('fetch', mockFetch);

        const result = await senriGet('/api/external/sage/products');

        expect(result).toEqual({ products: [] });
        expect(mockFetch).toHaveBeenCalledTimes(4);

        // Verify retry used new token
        const retryCall = mockFetch.mock.calls[3];
        expect(retryCall[1].headers.Authorization).toBe('Bearer tok-new');
    });

    it('throws on non-401 error', async () => {
        initSenri('my-key', 'my-secret');

        const mockFetch = vi.fn()
            // Auth succeeds
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: 'tok-123' }),
            })
            // GET returns 500
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error',
            });

        vi.stubGlobal('fetch', mockFetch);

        await expect(senriGet('/open_api/v1/users')).rejects.toThrow(
            'Senri API error (500',
        );
    });

    it('throws on auth failure', async () => {
        initSenri('bad-key', 'bad-secret');

        const mockFetch = vi.fn().mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => 'Invalid credentials',
        });

        vi.stubGlobal('fetch', mockFetch);

        await expect(senriGet('/open_api/v1/users')).rejects.toThrow(
            'Senri auth failed (401)',
        );
    });

    it('filters out undefined params from query string', async () => {
        initSenri('my-key', 'my-secret');

        const mockFetch = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ access_token: 'tok-123' }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ retailers: [] }),
            });

        vi.stubGlobal('fetch', mockFetch);

        await senriGet('/api/external/sage/retailers', {
            updated_at_gteq: '20240101',
            page: undefined,
        });

        const getCall = mockFetch.mock.calls[1];
        const url = new URL(getCall[0]);
        expect(url.searchParams.get('updated_at_gteq')).toBe('20240101');
        expect(url.searchParams.has('page')).toBe(false);
    });
});
