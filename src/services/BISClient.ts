/**
 * Best in Slot (BIS) API client.
 *
 * Used to verify inscription collection membership before signing attestations.
 * BIS is the most comprehensive off-chain collection index for Bitcoin Ordinals.
 *
 * API docs: https://api.bestinslot.xyz
 *
 * Rate limits (free tier): ~3 req/sec. Pass an API key to increase limits.
 * Results are cached locally — each inscription's collection never changes.
 */

const BASE_URL = 'https://api.bestinslot.xyz/v3';

interface IBISInscriptionInfo {
    readonly inscription_id: string;
    readonly collection_slug: string | null;
    readonly inscription_number: number;
    readonly owner_address: string;
    readonly genesis_address: string;
    readonly content_type: string;
    readonly genesis_block_height: number;
}

interface IBISResponse {
    readonly data: IBISInscriptionInfo;
}

export class BISClient {
    private readonly apiKey: string | null;
    /** In-memory cache: inscriptionId → collection slug (or null if uncollected) */
    private readonly cache = new Map<string, string | null>();

    constructor(apiKey?: string) {
        this.apiKey = apiKey ?? null;
    }

    /**
     * Returns the collection slug for an inscription, or null if uncollected.
     * Results are cached permanently (collection membership is immutable).
     *
     * @throws if BIS API is unreachable after retries
     */
    public async getCollectionSlug(inscriptionId: string): Promise<string | null> {
        if (this.cache.has(inscriptionId)) {
            return this.cache.get(inscriptionId)!;
        }

        const slug = await this.fetchWithRetry(inscriptionId);
        this.cache.set(inscriptionId, slug);
        return slug;
    }

    /**
     * Verifies that an inscription belongs to the expected collection.
     *
     * @param inscriptionId     - Full inscription ID (e.g. "abc123...i0")
     * @param expectedSlug      - BIS collection slug (e.g. "bitcoin-frogs")
     * @returns true if the inscription is in the collection
     * @throws if BIS API is unreachable after retries
     */
    public async isInCollection(inscriptionId: string, expectedSlug: string): Promise<boolean> {
        const slug = await this.getCollectionSlug(inscriptionId);
        return slug === expectedSlug;
    }

    // ─── Private ─────────────────────────────────────────────────────────────────

    private async fetchWithRetry(
        inscriptionId: string,
        retries = 3,
        delayMs = 1000,
    ): Promise<string | null> {
        const url = `${BASE_URL}/inscription/info?inscription_id=${encodeURIComponent(inscriptionId)}`;

        const headers: Record<string, string> = {
            'Accept': 'application/json',
        };
        if (this.apiKey) {
            headers['x-api-key'] = this.apiKey;
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(url, { headers });

                if (response.status === 404) {
                    // Inscription not found in BIS index — treat as uncollected
                    return null;
                }

                if (response.status === 429) {
                    // Rate limited — wait and retry
                    const waitMs = delayMs * attempt;
                    await this.sleep(waitMs);
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`BIS API returned HTTP ${response.status.toString()}`);
                }

                const body = await response.json() as IBISResponse;
                return body.data?.collection_slug ?? null;

            } catch (err: unknown) {
                if (attempt === retries) throw err;
                await this.sleep(delayMs * attempt);
            }
        }

        throw new Error(`BIS API unreachable after ${retries.toString()} attempts`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
